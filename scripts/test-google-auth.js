/** Real Google module, isolated effects. All credentials here are synthetic. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'lib/google.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const tests = [];
const test = (name, run) => tests.push({ name, run });
function harness(options = {}) {
  const store = options.store || {};
  const effects = [];
  const chrome = {
    runtime: { getManifest: () => manifest },
    storage: { local: {
      async get(key) { return typeof key === 'string' ? { [key]: store[key] } : { ...store }; },
      async set(value) { effects.push(['set', value]); Object.assign(store, value); },
      async remove(key) { effects.push(['remove', key]); delete store[key]; },
    } },
    identity: {
      getRedirectURL: () => 'https://synthetic.chromiumapp.org/',
      getAuthToken(details, cb) {
        effects.push(['chrome', details]);
        if (options.chrome) return options.chrome(details, cb, chrome);
        cb('synthetic-chrome-token');
      },
      launchWebAuthFlow(details, cb) {
        effects.push(['web', details]);
        if (options.web) return options.web(details, cb, chrome);
        cb(undefined);
      },
      removeCachedAuthToken(details, cb) { effects.push(['forget', details]); cb(); },
    },
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, crypto: crypto.webcrypto, console,
    fetch: async (url, init) => {
      effects.push(['fetch', url, init]);
      if (options.fetch) return options.fetch(url, init);
      return { ok: true, status: 200, json: async () => ({ documentId: 'synthetic-doc', title: 'Test document' }) };
    },
  });
  vm.runInContext(source, context);
  return { google: context.FA.google, store, effects, chrome };
}
const disabled = (_, cb, chrome) => {
  chrome.runtime.lastError = { message: 'Service has been disabled for this account.' };
  cb();
  delete chrome.runtime.lastError;
};
function callbackFor(details) {
  const request = new URL(details.url);
  const response = new URL(request.searchParams.get('redirect_uri'));
  response.hash = new URLSearchParams({ state: request.searchParams.get('state') || '', access_token: 'synthetic-web-token', token_type: 'Bearer', expires_in: '3600' }).toString();
  return response;
}
const webSuccess = (details, cb) => cb(callbackFor(details).href);
test('manifest has permanent RSA public identity and unchanged scopes', () => {
  assert.equal(typeof manifest.key, 'string', 'manifest must contain a permanent public key');
  const der = Buffer.from(manifest.key, 'base64');
  const key = crypto.createPublicKey({ key: der, type: 'spki', format: 'der' });
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.equal(key.asymmetricKeyDetails.modulusLength, 2048);
  const id = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, n => String.fromCharCode(97 + parseInt(n, 16)));
  assert.match(id, /^[a-p]{32}$/);
  assert.deepEqual(manifest.oauth2.scopes, ['documents', 'drive.file', 'calendar.events'].map(s => 'https://www.googleapis.com/auth/' + s));
});
test('first-run status is storage-only and disconnected', async () => {
  const h = harness();
  assert.equal(typeof h.google.status, 'function', 'shared status reader must exist');
  assert.equal((await h.google.status()).status, 'disconnected');
  assert.equal(h.effects.length, 0);
});
test('explicit Chrome connection persists across contexts and authenticates Docs', async () => {
  const h = harness();
  assert.equal(await h.google.connect(), true);
  assert.equal(h.store.googleAuthState?.status, 'connected', 'explicit connect must persist connected status');
  assert.equal(h.store.googleAuthState.selectedDoor, 'chrome');
  assert.equal(h.store.googleAuthState.everConnected, true);
  const doc = await h.google.getDoc('synthetic-doc');
  assert.equal(doc.title, 'Test document');
  assert.equal(h.effects.find(e => e[0] === 'fetch')[2].headers.Authorization, 'Bearer synthetic-chrome-token');
  const reopened = harness({ store: h.store });
  assert.equal((await reopened.google.status()).status, 'connected');
  assert.equal((await reopened.google.account()).door, 'chrome');
  assert.equal(reopened.effects.length, 0);
  assert.ok(!JSON.stringify(h.store.googleAuthState).includes('synthetic-chrome-token'));
});
test('concurrent explicit connects share one identity callback', async () => {
  let finish;
  const h = harness({ chrome: (_, cb) => { finish = cb; } });
  const attempts = [h.google.connect(), h.google.connect()];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.effects.filter(e => e[0] === 'chrome').length, 1, 'only one Chrome chooser may be pending');
  finish('synthetic-chrome-token');
  assert.deepEqual(await Promise.all(attempts), [true, true]);
});

test('disabled Chrome falls directly through one validated personal chooser', async () => {
  const h = harness({ chrome: disabled, web: webSuccess });
  await h.google.connect();
  assert.equal(h.effects.filter(e => e[0] === 'chrome').length, 1);
  assert.equal(h.effects.filter(e => e[0] === 'web').length, 1);
  const request = new URL(h.effects.find(e => e[0] === 'web')[1].url);
  assert.match(request.searchParams.get('state') || '', /^[a-f0-9]{64}$/, 'web chooser must use 256-bit random state');
  assert.equal(h.store.googleAuthState.selectedDoor, 'web');
  await h.google.getDoc('synthetic-doc');
  assert.equal(h.effects.filter(e => e[0] === 'fetch').at(-1)[2].headers.Authorization, 'Bearer synthetic-web-token');
});

const invalidCallbacks = {
  'missing state': u => { const f = new URLSearchParams(u.hash.slice(1)); f.delete('state'); u.hash = f; },
  'mismatched state': u => { u.hash += '&state=wrong'; },
  'duplicated matching state': u => { const f = new URLSearchParams(u.hash.slice(1)); f.append('state', f.get('state')); u.hash = f; },
  'wrong origin': u => { u.hostname = 'attacker.example'; },
  'wrong path': u => { u.pathname = '/other'; },
  'query parameters': u => { u.search = '?extra=1'; },
  'URL credentials': u => { u.username = 'attacker'; },
  'token plus error': u => { u.hash += '&error=access_denied'; },
  'missing token': u => { const f = new URLSearchParams(u.hash.slice(1)); f.delete('access_token'); u.hash = f; },
  'duplicate token': u => { u.hash += '&access_token=second'; },
  'invalid token type': u => { u.hash = u.hash.replace('Bearer', 'Basic'); },
  'missing token type': u => { const f = new URLSearchParams(u.hash.slice(1)); f.delete('token_type'); u.hash = f; },
  'nonfinite expiry': u => { u.hash = u.hash.replace('3600', 'Infinity'); },
  'zero expiry': u => { u.hash = u.hash.replace('3600', '0'); },
  'negative expiry': u => { u.hash = u.hash.replace('3600', '-1'); },
  'missing expiry': u => { const f = new URLSearchParams(u.hash.slice(1)); f.delete('expires_in'); u.hash = f; },
  'duplicate expiry': u => { u.hash += '&expires_in=3600'; },
};
for (const [name, mutate] of Object.entries(invalidCallbacks)) test('reject callback: ' + name, async () => {
  const h = harness({ chrome: disabled, web(details, cb) { const u = callbackFor(details); mutate(u); cb(u.href); } });
  await assert.rejects(h.google.connect(), e => typeof e.category === 'string');
  assert.equal(h.effects.filter(e => e[0] === 'set').length, 0, 'invalid callback must never write credentials or success');
  assert.equal(h.effects.filter(e => e[0] === 'fetch').length, 0, 'invalid callback must never send bearer token');
});
test('web states differ between attempts and error callbacks also require state', async () => {
  const states = [];
  const h = harness({ chrome: disabled, web(details, cb) {
    states.push(new URL(details.url).searchParams.get('state'));
    cb('https://synthetic.chromiumapp.org/#error=access_denied&state=wrong');
  } });
  for (let i = 0; i < 2; i++) await assert.rejects(h.google.connect(), e => e.category === 'configuration');
  assert.ok(states[0] && states[0] !== states[1]);
});
test('silent fallback and worker connect never escalate interaction', async () => {
  const h = harness({ chrome: disabled, web: webSuccess });
  await h.google.getDoc('synthetic-doc');
  h.google.setInteractive(false);
  await h.google.connect();
  assert.ok(h.effects.filter(e => ['chrome', 'web'].includes(e[0])).every(e => e[1].interactive === false));
});
test('expired legacy web token retains selected door and silent identity hint', async () => {
  const h = harness({ store: { googleWebToken: { access_token: 'expired', expires_at: 1, email: 'prior@example.test' } }, web: webSuccess });
  assert.equal((await h.google.status()).selectedDoor, 'web');
  assert.equal((await h.google.status()).status, 'disconnected');
  assert.equal(h.effects.length, 0);
  await h.google.getDoc('synthetic-doc');
  assert.equal(h.effects.filter(e => e[0] === 'chrome').length, 0);
  assert.equal(h.store.googleWebToken.email, 'prior@example.test');
});
test('explicit web selection cannot retain stale email when userinfo is absent', async () => {
  const h = harness({ store: { googleWebToken: { access_token: 'old', expires_at: Date.now() + 3600000, email: 'prior@example.test' } }, web: webSuccess });
  await h.google.connect();
  assert.equal(h.effects.filter(e => e[0] === 'web').length, 1, 'explicit selection must reach account chooser');
  assert.equal(h.store.googleWebToken.email, '');
});
test('silent conflicting account hint is rejected without adopting new credentials', async () => {
  const h = harness({ store: { googleWebToken: { access_token: 'old', expires_at: 1, email: 'prior@example.test' } }, web: webSuccess,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ email: 'different@example.test' }) }) });
  await assert.rejects(h.google.getDoc('synthetic-doc'), e => e.category === 'authorization');
  assert.equal(h.store.googleWebToken.access_token, 'old');
  assert.equal(h.effects.filter(e => e[0] === 'fetch' && e[1].includes('docs.googleapis.com')).length, 0);
});
test('valid cancellation preserves an established connection and both attempted classifications', async () => {
  const previous = { version: 1, status: 'connected', selectedDoor: 'chrome', everConnected: true, reason: null };
  const h = harness({ store: { googleAuthState: previous }, chrome: disabled, web(details, cb) {
    const u = callbackFor(details); u.hash = new URLSearchParams({ state: new URL(details.url).searchParams.get('state'), error: 'access_denied' }); cb(u.href);
  } });
  await assert.rejects(h.google.connect(), e => e.category === 'cancelled' && e.attempts?.[0].category === 'policy_disabled');
  assert.equal(h.store.googleAuthState, previous);
});
test('disconnect supersedes pending connect without late success writes', async () => {
  let finish;
  const h = harness({ chrome: (_, cb) => { finish = cb; } });
  const pending = h.google.connect();
  const rejected = assert.rejects(pending, e => e.category === 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  await h.google.disconnect();
  finish('late-synthetic-token');
  await rejected;
  assert.equal(h.store.googleAuthState.status, 'disconnected');
});

(async () => {
  let passed = 0;
  for (const [i, { name, run }] of tests.entries()) {
    let timer;
    try { await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('case timed out')), 1500); })]); passed++; console.log(`ok ${i + 1} - ${name}`); }
    catch (e) { console.log(`not ok ${i + 1} - ${name}\n# FAIL ${e.message.replace(/\n/g, ' ')}`); }
    finally { clearTimeout(timer); }
  }
  console.log(`1..${tests.length}\n# tests ${tests.length}\n# pass ${passed}\n# fail ${tests.length - passed}`);
  console.log(`${passed}/${tests.length} executed Google auth cases passed`);
  process.exitCode = tests.length > 0 && passed === tests.length ? 0 : 1;
})();
