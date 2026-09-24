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

(async () => {
  let passed = 0;
  for (const [i, { name, run }] of tests.entries()) {
    try { await run(); passed++; console.log(`ok ${i + 1} - ${name}`); }
    catch (e) { console.log(`not ok ${i + 1} - ${name}\n# FAIL ${e.message.replace(/\n/g, ' ')}`); }
  }
  console.log(`1..${tests.length}\n# tests ${tests.length}\n# pass ${passed}\n# fail ${tests.length - passed}`);
  console.log(`${passed}/${tests.length} executed Google auth cases passed`);
  process.exitCode = tests.length > 0 && passed === tests.length ? 0 : 1;
})();
