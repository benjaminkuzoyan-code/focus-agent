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
  const listeners = [];
  const emit = changes => listeners.forEach(fn => fn(changes, 'local'));
  const chrome = {
    runtime: { getManifest: () => manifest },
    storage: { local: {
      async get(key) { return typeof key === 'string' ? { [key]: store[key] } : { ...store }; },
      async set(value) { effects.push(['set', value]); const changes = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, { oldValue: store[k], newValue: v }])); Object.assign(store, value); emit(changes); },
      async remove(key) { effects.push(['remove', key]); const oldValue = store[key]; delete store[key]; emit({ [key]: { oldValue } }); },
    }, onChanged: { addListener(fn) { listeners.push(fn); } } },
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

const connected = (door = 'chrome') => ({ version: 1, status: 'connected', selectedDoor: door, everConnected: true, reason: null });
const response = (status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ title: 'Recovered', error: { message: 'PRIVATE provider payload' } }), arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer });
const identityFailure = message => (_, cb, chrome) => { chrome.runtime.lastError = { message }; cb(); delete chrome.runtime.lastError; };
const oauthFailure = error => (details, cb) => { const u = callbackFor(details); u.hash = new URLSearchParams({ state: new URL(details.url).searchParams.get('state'), error }); cb(u.href); };
test('terminal 401 retries once, evicts both exact tokens and persists reconnect', async () => {
  let n = 0;
  const h = harness({ store: { googleAuthState: connected() }, chrome: (_, cb) => cb('token-' + ++n), fetch: async () => response(401) });
  await assert.rejects(h.google.getDoc('doc'), e => e.category === 'authorization');
  assert.equal(h.effects.filter(e => e[0] === 'fetch').length, 2);
  assert.deepEqual(h.effects.filter(e => e[0] === 'forget').map(e => e[1].token), ['token-1', 'token-2']);
  assert.equal(h.store.googleAuthState.status, 'reconnect');
  assert.ok(h.effects.filter(e => e[0] === 'chrome').every(e => e[1].interactive === false));
});
test('Drive bytes share one silent 401 retry and preserve binary data', async () => {
  let n = 0;
  const h = harness({ store: { googleAuthState: connected() }, fetch: async () => response(++n === 1 ? 401 : 200) });
  assert.deepEqual([...new Uint8Array(await h.google.fetchDriveFileBytes('file'))], [1, 2, 3]);
  assert.equal(n, 2);
  assert.equal(h.store.googleAuthState.status, 'connected');
});
test('saved web 401 retains chosen door and identity hint during renewal', async () => {
  let n = 0;
  const h = harness({ store: { googleAuthState: connected('web'), googleWebToken: { access_token: 'old', expires_at: Date.now() + 3600000, email: 'chosen@example.test' } }, web: webSuccess,
    fetch: async url => url.includes('userinfo') ? response() : response(++n === 1 ? 401 : 200) });
  await h.google.getDoc('doc');
  assert.equal(h.effects.filter(e => e[0] === 'chrome').length, 0);
  assert.equal(new URL(h.effects.find(e => e[0] === 'web')[1].url).searchParams.get('login_hint'), 'chosen@example.test');
  assert.equal(h.store.googleAuthState.selectedDoor, 'web');
});
for (const [message, category] of [['login_required', 'authorization'], ['network offline', 'network'], ['invalid_client', 'configuration'], ['mystery', 'unknown'], ['access_denied', 'cancelled'], ['Service has been disabled for this account.', 'policy_disabled']]) {
  test('mixed silent causes preserve status: ' + category, async () => {
    const h = harness({ store: { googleAuthState: connected() }, chrome: identityFailure(message), web: oauthFailure('login_required') });
    await assert.rejects(h.google.getDoc('doc'), e => e.category === category && (category === 'cancelled' || e.attempts.length === 2));
    assert.equal(h.store.googleAuthState.status, category === 'authorization' ? 'reconnect' : 'connected');
  });
}
test('first-run authorization failure remains disconnected', async () => {
  const h = harness({ chrome: identityFailure('login_required'), web: oauthFailure('login_required') });
  await assert.rejects(h.google.getDoc('doc'), e => e.category === 'authorization');
  assert.equal((await h.google.status()).status, 'disconnected');
});
for (const [code, category] of [[403, 'resource'], [404, 'resource'], [429, 'network'], [500, 'network']]) test('HTTP ' + code + ' stays distinct and sanitized', async () => {
  const h = harness({ store: { googleAuthState: connected() }, fetch: async () => response(code) });
  await assert.rejects(h.google.getDoc('doc'), e => e.category === category && e.status === code && !e.message.includes('PRIVATE'));
  assert.equal(h.store.googleAuthState.status, 'connected');
  assert.equal(h.effects.filter(e => e[0] === 'fetch').length, 1);
});
test('ambiguous network failure never replays a Calendar write', async () => {
  const h = harness({ store: { googleAuthState: connected() }, fetch: async () => { throw new Error('PRIVATE offline'); } });
  await assert.rejects(h.google.addEvent({ title: 'focus', start: 0, end: 60000 }), e => e.category === 'network' && !e.message.includes('PRIVATE'));
  assert.equal(h.effects.filter(e => e[0] === 'fetch').length, 1);
});
test('successful 204 keeps null response shape', async () => {
  const h = harness({ fetch: async () => response(204) });
  assert.equal(await h.google.getDoc('doc'), null);
});
test('external disconnect supersedes delayed identity success', async () => {
  let finish;
  const h = harness({ store: { googleAuthState: connected() }, chrome: (_, cb) => { finish = cb; } });
  const pending = h.google.getDoc('doc');
  const rejected = assert.rejects(pending, e => e.category === 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  await h.chrome.storage.local.remove('googleAuthState');
  finish('late-token');
  await rejected;
  assert.equal((await h.google.status()).status, 'disconnected');
  assert.equal(h.effects.filter(e => e[0] === 'fetch').length, 0);
});
test('late web 401 cannot erase newer credentials or successful status', async () => {
  let finish, calls = 0;
  const h = harness({ store: { googleAuthState: connected('web'), googleWebToken: { access_token: 'old', expires_at: Date.now() + 3600000 } }, web: webSuccess,
    fetch: async url => url.includes('userinfo') ? response() : ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : response() });
  const pending = h.google.getDoc('doc');
  await new Promise(resolve => setImmediate(resolve));
  await h.google.connect();
  finish(response(401));
  await pending.catch(e => assert.equal(e.category, 'cancelled'));
  assert.equal(h.store.googleWebToken.access_token, 'synthetic-web-token');
  assert.equal(h.store.googleAuthState.status, 'connected');
});
test('late terminal Chrome failure cannot replace newer successful status', async () => {
  let finish, acquisitions = 0, calls = 0;
  const h = harness({ store: { googleAuthState: connected() }, chrome: (_, cb) => cb('token-' + ++acquisitions),
    fetch: async () => ++calls === 1 ? response(401) : calls === 2 ? new Promise(resolve => { finish = resolve; }) : response() });
  const old = h.google.getDoc('old');
  const rejected = assert.rejects(old, e => e.category === 'authorization');
  await new Promise(resolve => setImmediate(resolve));
  await h.google.getDoc('new');
  finish(response(401));
  await rejected;
  assert.equal(h.store.googleAuthState.status, 'connected');
  assert.deepEqual(h.effects.filter(e => e[0] === 'forget').map(e => e[1].token), ['token-1', 'token-2']);
});
test('expired selected web grant marks reconnect without adopting Chrome', async () => {
  const h = harness({ store: { googleAuthState: connected('web'), googleWebToken: { access_token: 'expired', expires_at: 1 } }, web: oauthFailure('login_required') });
  await assert.rejects(h.google.getDoc('doc'), e => e.category === 'authorization');
  assert.equal(h.store.googleAuthState.status, 'reconnect');
  assert.equal(h.effects.filter(e => e[0] === 'chrome').length, 0);
});
test('external account selection cancels an interleaved Chrome request', async () => {
  let finish;
  const h = harness({ store: { googleAuthState: connected() }, fetch: async () => new Promise(resolve => { finish = resolve; }) });
  const old = h.google.getDoc('old');
  const rejected = assert.rejects(old, e => e.category === 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  await h.chrome.storage.local.set({ googleAuthState: connected('web'), googleWebToken: { access_token: 'replacement', expires_at: Date.now() + 3600000 } });
  finish(response(401));
  await rejected;
  assert.equal(h.store.googleWebToken.access_token, 'replacement');
  assert.equal(h.store.googleAuthState.selectedDoor, 'web');
});
test('offline revocation still clears local connection and credentials', async () => {
  const h = harness({ store: { googleAuthState: connected('web'), googleWebToken: { access_token: 'old', expires_at: Date.now() + 3600000 } }, fetch: async () => { throw new Error('offline'); } });
  await h.google.disconnect();
  assert.equal(h.store.googleWebToken, undefined);
  assert.equal((await h.google.status()).status, 'disconnected');
  assert.equal((await h.google.status()).selectedDoor, null);
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
