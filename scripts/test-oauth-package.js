/** Public identity and staged-distribution gate. Fixtures never use private keys. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const EXPECTED_ID = 'hamjokekeddfckjjfmciillddifhdeda';

function publicDer(value) {
  try {
    if (typeof value !== 'string' || !value.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error();
    const der = Buffer.from(value, 'base64');
    if (der.toString('base64') !== value) throw new Error();
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa' || !key.export({ format: 'der', type: 'spki' }).equals(der)) throw new Error();
    return der;
  } catch { throw new Error('Expected canonical public RSA SPKI key'); }
}

function deriveExtensionId(value) {
  return crypto.createHash('sha256').update(publicDer(value)).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`Invalid or unreadable JSON: ${file}`); }
}

function hasSecretField(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /^(client[_-]?secret|private[_-]?key)$/i.test(key) || hasSecretField(child));
}

function validatePackageTree(directory) {
  const stage = path.resolve(directory);
  const files = [];
  // Reject links before reading: scanning must never follow an unexpected secret
  // outside the test/build-owned tree (including a symlinked manifest).
  function scan(dir) {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(`Directory required (no symlinks): ${dir}`);
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Forbidden symlink: ${file}`);
      if (stat.isDirectory()) { scan(file); continue; }
      if (!stat.isFile()) throw new Error(`Unsupported staged file: ${file}`);
      if (/\.pem$/i.test(name) || /^\.env(?:\.|$)/i.test(name) || /^(api_key|tokens)$/i.test(name)) {
        throw new Error(`Forbidden credential file: ${file}`);
      }
      const content = fs.readFileSync(file, 'utf8');
      if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(content)
          || /\bclient[_-]?secret\b["']?\s*[:=]/i.test(content)
          || (/\.json$/i.test(name) && hasSecretField(readJson(file)))) {
        throw new Error(`Forbidden credential content: ${file}`);
      }
      files.push(file);
    }
  }
  scan(stage);
  const source = readJson(path.join(ROOT, 'manifest.json'));
  const manifestPath = path.join(stage, 'manifest.json');
  const staged = readJson(manifestPath);
  const extensionId = deriveExtensionId(source.key);
  if (extensionId !== EXPECTED_ID || deriveExtensionId(staged.key) !== extensionId
      || !publicDer(source.key).equals(publicDer(staged.key))) throw new Error(`Public identity mismatch: ${manifestPath}`);
  const expected = structuredClone(source);
  expected.host_permissions = (expected.host_permissions || []).filter(h => !/localhost|127\.0\.0\.1/.test(h));
  if (!expected.host_permissions.length) delete expected.host_permissions;
  for (const script of expected.content_scripts || []) script.matches = (script.matches || []).filter(h => !/localhost|127\.0\.0\.1/.test(h));
  try { assert.deepEqual(staged, expected); }
  catch { throw new Error(`Unexpected staged manifest configuration: ${manifestPath}`); }
  function webClient(file) {
    const match = fs.readFileSync(file, 'utf8').match(/const WEB_CLIENT_ID\s*=\s*"([^"]+)"/);
    if (!match) throw new Error(`Missing public web client: ${file}`);
    return match[1];
  }
  const stagedGoogle = path.join(stage, 'lib/google.js');
  if (webClient(stagedGoogle) !== webClient(path.join(ROOT, 'lib/google.js'))) throw new Error(`Changed public web client: ${stagedGoogle}`);
  return { extensionId, files: files.length };
}

module.exports = { deriveExtensionId, validatePackageTree };

function runTests() {
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const google = fs.readFileSync(path.join(ROOT, 'lib/google.js'), 'utf8');
  const tests = [];
  const test = (name, run) => tests.push({ name, run });
  const derive = key => {
    assert.equal(typeof module.exports.deriveExtensionId, 'function', 'deriveExtensionId export required');
    return module.exports.deriveExtensionId(key);
  };
  const validate = dir => {
    assert.equal(typeof module.exports.validatePackageTree, 'function', 'validatePackageTree export required');
    return module.exports.validatePackageTree(dir);
  };
  function fixture(build, mutate, check) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-oauth-package-'));
    try {
      const manifest = structuredClone(source);
      manifest.host_permissions = manifest.host_permissions.filter(h => !/localhost|127\.0\.0\.1/.test(h));
      if (!manifest.host_permissions.length) delete manifest.host_permissions;
      for (const script of manifest.content_scripts || []) script.matches = script.matches.filter(h => !/localhost|127\.0\.0\.1/.test(h));
      fs.mkdirSync(path.join(dir, 'lib'));
      fs.writeFileSync(path.join(dir, 'lib/google.js'), google);
      if (build === 'friends') fs.writeFileSync(path.join(dir, 'build.json'), '{"build":"friends"}');
      mutate(manifest, dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      check(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  test('source public RSA SPKI derives the permanent ID', () => assert.equal(derive(source.key), EXPECTED_ID));
  for (const [name, key] of [
    ['missing', undefined], ['empty', ''], ['malformed base64', '!not-base64!'],
    ['non-key DER', Buffer.from('synthetic invalid DER').toString('base64')],
    ['private marker', '-----BEGIN PRIVATE KEY-----\nsynthetic-only'],
    ['trailing DER bytes', Buffer.concat([Buffer.from(source.key, 'base64'), Buffer.from([0])]).toString('base64')],
  ]) test(`rejects ${name} public key`, () => assert.throws(() => derive(key), /public RSA SPKI/));
  const changes = [
    ['missing key', m => { delete m.key; }, /public RSA SPKI/],
    ['changed key', m => {
      // Mutate only the PUBLIC modulus; no key generation or private material.
      const jwk = crypto.createPublicKey({ key: Buffer.from(m.key, 'base64'), format: 'der', type: 'spki' }).export({ format: 'jwk' });
      const modulus = Buffer.from(jwk.n, 'base64url'); modulus[20] ^= 1; jwk.n = modulus.toString('base64url');
      m.key = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'der', type: 'spki' }).toString('base64');
    }, /identity/],
    ['Chrome client drift', m => { m.oauth2.client_id = 'synthetic.apps.googleusercontent.com'; }, /manifest/],
    ['scope drift', m => { m.oauth2.scopes.push('synthetic-scope'); }, /manifest/],
    ['localhost retained', m => { m.host_permissions.push('http://127.0.0.1:8000/*'); }, /manifest/],
    ['new permission', m => { m.permissions.push('debugger'); }, /manifest/],
    ['web client drift', (_, dir) => fs.writeFileSync(path.join(dir, 'lib/google.js'), 'const WEB_CLIENT_ID = "synthetic.apps.googleusercontent.com";'), /web client/],
    ['PEM file', (_, dir) => fs.writeFileSync(path.join(dir, 'lib/leak.PEM'), 'synthetic-only'), /credential/],
    ['private marker', (_, dir) => fs.writeFileSync(path.join(dir, 'lib/leak.txt'), '-----BEGIN RSA PRIVATE KEY-----\nsynthetic-only'), /credential/],
    ['client secret JSON', (_, dir) => fs.writeFileSync(path.join(dir, 'leak.json'), '{"web":{"client_secret":"synthetic-secret-value"}}'), /credential/],
    ['client secret JS', (_, dir) => fs.writeFileSync(path.join(dir, 'lib/leak.js'), 'const clientSecret = "synthetic-secret-value";'), /credential/],
    ['escaped client secret JSON', (_, dir) => fs.writeFileSync(path.join(dir, 'leak.json'), '{"client\\u005fsecret":"synthetic-secret-value"}'), /credential/],
    ['symlink', (_, dir) => fs.symlinkSync(path.join(ROOT, 'manifest.json'), path.join(dir, 'link.json')), /symlink/],
  ];
  for (const build of ['store', 'friends']) {
    test(`${build} retains public identity and permits public clients`, () => fixture(build, () => {}, dir => {
      assert.equal(validate(dir).extensionId, EXPECTED_ID);
      const result = spawnSync(process.execPath, [__filename, '--stage', dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Package OAuth validation passed/);
    }));
    for (const [name, mutate, message] of changes) test(`${build} rejects ${name} before ZIP`, () => fixture(build, mutate, dir => {
      assert.throws(() => validate(dir), message);
      const result = spawnSync(process.execPath, [__filename, '--stage', dir], { encoding: 'utf8' });
      assert.equal(result.status, 1, 'unsafe staged CLI must fail');
      assert.match(result.stderr, message);
      assert.ok(!result.stderr.includes('synthetic-secret-value'), 'diagnostics must not expose content');
    }));
  }
  let passed = 0;
  for (const [index, { name, run }] of tests.entries()) {
    try { run(); passed++; console.log(`ok ${index + 1} - ${name}`); }
    catch (error) { console.error(`not ok ${index + 1} - ${name}\n# FAIL ${error.message.replace(/\n/g, '\n# ')}`); }
  }
  console.log(`# tests ${tests.length}\n# pass ${passed}\n# fail ${tests.length - passed}`);
  console.log(`${passed}/${tests.length} OAuth package cases passed`);
  if (!tests.length || passed !== tests.length) process.exitCode = 1;
}

if (require.main === module) {
  if (process.argv.length === 2) runTests();
  else {
    try {
      if (process.argv.length !== 4 || process.argv[2] !== '--stage') throw new Error('Usage: node scripts/test-oauth-package.js [--stage DIR]');
      assert.equal(typeof module.exports.validatePackageTree, 'function', 'staged credential validator must exist');
      const result = module.exports.validatePackageTree(process.argv[3]);
      console.log(`Package OAuth validation passed: ${result.extensionId} (${result.files} files)`);
    } catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
  }
}
