# Phase 1: Stable Extension ID + OAuth Hardening - Pattern Map

**Mapped:** 2026-09-24
**Files analyzed:** 11 candidate implementation files (optional files identified below)
**Analogs found:** 11 / 11 structural matches; no existing typed OAuth-state implementation

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `manifest.json` | config | request-response | existing `manifest.json` | exact |
| `.gitignore` (verify; probably no edit) | config | file-I/O | existing `.gitignore` | exact |
| `lib/google.js` | service | request-response, event-driven | existing `lib/google.js` | exact |
| `sidepanel/panel.js` | component | event-driven | existing Google chip in `sidepanel/panel.js` | exact |
| `sidepanel/panel.css` (optional state styling) | component | transform | existing `.chip` rules | exact |
| `scripts/test-google-auth.js` (proposed name) | test | request-response | `scripts/test-panel-boundary.js` | role-match |
| `scripts/smoke-panel.js` | test | event-driven | existing jsdom smoke boot | exact |
| `scripts/harness/shim.js` (if manual harness needs new API mocks) | utility | event-driven | existing shim and smoke Chrome mocks | exact |
| `scripts/package-store.sh` | utility | file-I/O, transform | existing staged-manifest checks | exact |
| `package.json` | config | batch | existing test script | exact |
| `docs/OAUTH-RUNBOOK.md` (proposed name) | utility/documentation | batch | `deploy/README.md` | role-match |

Names of additions are planner recommendations, not locked decisions. No new framework, controller, route, or auth middleware is needed. `sidepanel/panel.html:332` already provides the Google button; reuse it unless accessibility changes require markup.

## Pattern Assignments

### `manifest.json`, `.gitignore`, `scripts/package-store.sh`

**Analog:** existing tracked files. Manifest lines 71–78 own OAuth scopes/client configuration; preserve the three scopes. The `key` belongs at manifest top level, alongside other metadata.

**Existing private-key exclusion**, `.gitignore:6–11`:
```gitignore
# secrets: never commit these (repo is public)
.env
.env.*
api_key
tokens
*.pem
```
D-01's exclusion is already satisfied; do not add redundant entries. Generate once, commit only the public manifest key, and never regenerate automatically during packaging.

**Packaging transform**, `scripts/package-store.sh:34–42`:
```python
import json, sys
path = sys.argv[1]
m = json.load(open(path))
m["host_permissions"] = [h for h in m.get("host_permissions", []) if "localhost" not in h and "127.0.0.1" not in h]
if not m["host_permissions"]:
    del m["host_permissions"]
for cs in m.get("content_scripts", []):
    cs["matches"] = [x for x in cs["matches"] if "localhost" not in x and "127.0.0.1" not in x]
json.dump(m, open(path, "w"), indent=2)
```
This transform naturally preserves `key`. Copy the staged-check location at lines 51–61 for a source/staged key equality and validity check if added. The allowlisted copies at lines 27–29 exclude private files by construction. Check both standard and friends archives; neither is a separate identity.

### `lib/google.js`

**Analog:** same file. No imports: browser scripts share `FA` via an IIFE (`22–23`):
```js
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});
```

**Chrome callback/error boundary**, lines 53–59:
```js
function getChromeToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) reject(new Error(chrome.runtime.lastError?.message || "no token"));
      else resolve(token);
    });
  });
}
```
Classify at these boundaries while callback-scoped `lastError` is available. The current generic `Error` implementation is a location precedent, not an adequate classifier. Keep network/unknown errors separate from confirmed authorization failures, configuration failures, and user cancellation.

**Web token persistence**, lines 64–65 and 94–95:
```js
const { [WEB_TOKEN_KEY]: saved } = await chrome.storage.local.get(WEB_TOKEN_KEY);
if (saved?.access_token && saved.expires_at - Date.now() > 60000) return saved.access_token;
```
```js
await chrome.storage.local.set({ [WEB_TOKEN_KEY]: { access_token, expires_at, email } });
return access_token;
```
Keep the existing token key compatible. Persist only non-secret status/reason in any new state record; retain token material in its existing separate record. Correct the stale file/chip comments claiming no tokens are stored locally.

**Silent/interactive separation**, lines 75–76, 79–83:
```js
include_granted_scopes: "true",
prompt: interactive ? "select_account consent" : "none",
```
```js
const back = await new Promise((resolve, reject) => {
  chrome.identity.launchWebAuthFlow({ url, interactive }, (u) => {
    if (chrome.runtime.lastError || !u) reject(new Error(chrome.runtime.lastError?.message || "auth cancelled"));
    else resolve(u);
  });
});
```
Retain `chrome.identity.getRedirectURL()` at line 67 and manifest-derived scopes at line 51. Implement any callback validation and error classification centrally. D-03's interactive fallback must be conditional on a user-authorized interactive call; disabled-account detection from a silent probe must never open a chooser.

**Door selection**, lines 99–114: existing `getToken()` prefers a saved web token; otherwise Chrome first then web. Preserve personal-account preference through expiry/invalidation. Current `lastDoor` is mutable module state (`98`, `117–120`), so concurrent requests can invalidate the wrong cache; do not copy this as safe per-request provenance.

**Retry boundary**, lines 133–143:
```js
if (res.status === 401 && retry) {
  // Token expired/revoked: drop it and try once more.
  await forgetToken(token);
  return api(url, { method, body, retry: false });
}
if (!res.ok) {
  let detail = "";
  try {
    detail = (await res.json()).error?.message || "";
  } catch {}
  throw new Error(`Google ${res.status}${detail ? ": " + detail : ""}`);
}
```
Keep retry bounded. Current line 127 escalates *any* silent error to interactive auth when `allowInteractive` is true; this requires deliberate tightening for reconnect UX. Export additions through `FA.google` (`177+`) while preserving `connect`, `isConnected`, `account`, `disconnect`, and `setInteractive` callers. `account()` at 209–217 currently reports saved web tokens without checking expiry, so it cannot be the authoritative new state reader unchanged. Disconnect must clear reconnect status as well as credentials.

### `sidepanel/panel.js` and optional `sidepanel/panel.css`

**Analog:** Google chip (`3891–3921`) and existing storage listener (`3925–3942`).

**Rendering**, lines 3892–3897:
```js
async function renderGoogleChip() {
  const acct = await FA.google.account().catch(() => null);
  const chip = $("google-btn");
  chip.textContent = acct ? "G ✓ connected" : "connect G";
  chip.title = acct ? "Google connected (Docs + Calendar). Click to disconnect." : "Connect Google (Docs + Calendar)";
  $("google-note").textContent = acct?.email ? acct.email : acct ? "Chrome account" : "";
```
Extend this single renderer with disconnected/connected/reconnect-needed states. Keep `textContent` for user-visible strings. Avoid a fresh auth probe on every status-change event, which can cause a write/render/probe loop. Boot already invokes the renderer at line 4039.

**Click action**, lines 3901–3906:
```js
if (await FA.google.isConnected()) {
  if (confirm("Disconnect Google from Focus Agent?")) await FA.google.disconnect();
} else {
  chip.textContent = "G…";
  try {
    await FA.google.connect();
```
Reconnect should call the existing explicit connect action. Use typed failures for student copy instead of duplicating regex classification from lines 3909–3915. Preserve pending feedback and final render; prevent repeated clicks from creating concurrent choosers.

**Cross-context events**, lines 3925–3926:
```js
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
```
Add a narrowly scoped new-status-key branch here. Existing fields handle unrelated session changes; preserve them.

**Styling**, `sidepanel/panel.css:76–81`:
```css
.chip {
  font-size: 12px; padding: 4px 10px; border-radius: 999px;
  background: var(--glass); border: 1px solid var(--edge); color: var(--ink);
}
.chip-btn { cursor: pointer; transition: background 0.25s, transform 0.15s; }
.chip-btn:hover { background: var(--glass-strong); }
```
Use the existing `--amber` token (`18`) for a reconnect class if needed; visible wording must distinguish the state without relying on color.

### `scripts/test-google-auth.js` and `package.json`

**Analog:** `scripts/test-panel-boundary.js`, with plain Node/CommonJS and fake effects.

**Imports/real-source execution**, lines 18–23:
```js
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const root = path.resolve(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "sidepanel/panel.js"), "utf8");
const ai = fs.readFileSync(path.join(root, "lib/ai.js"), "utf8");
```
Adapt to read the whole `lib/google.js` into a fresh VM per case; test exported `FA.google` behavior. Stub `chrome`, `fetch`, `URL`, `URLSearchParams`, time, and crypto if the implementation uses it. Record identity options and effects instead of involving real profiles or tokens. For isolated panel functions, copy `fn()` extraction from lines 28–34, which throws if its source marker disappears.

**Failure exit**, lines 227–230:
```js
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
```
The same file's lines 141–152 model out-of-order async results using a manually resolved Promise: use this pattern for connect/disconnect races. Cover both auth doors, saved-web preference, expired authorization, transient failures, retry limit, callback validation if added, cleanup, and the invariant that every background/silent identity call has `interactive:false`.

`package.json:7` chains required checks with `&&`; append the new deterministic Node test there. No test runner dependency is needed. `scripts/test-docops.js:5–8` also demonstrates loading the browser IIFE with `globalThis.FA`, but fresh VM contexts better isolate OAuth module state.

### `scripts/smoke-panel.js` and `scripts/harness/shim.js`

**Analog:** existing real HTML + ordered source boot, smoke lines 85–92:
```js
const srcs = [...dom.window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"));
for (const src of srcs) {
  const file = path.join(ROOT, "sidepanel", src);
  try {
    window.eval(fs.readFileSync(file, "utf8"));
  } catch (e) {
    errors.push(`while loading ${src}: ${e.stack}`);
  }
}
```
Keep this as the integrated chip test: boot disconnected, inject a status storage change, assert reconnect label/title, click and assert interactive connect, then verify connected/disconnect behavior and refresh persistence.

**Storage events**, smoke lines 31–38:
```js
async set(obj) {
  const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { oldValue: store[k], newValue: v }]));
  Object.assign(store, obj);
  emit(changes);
},
async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); },
```
`scripts/harness/shim.js:26–33` mirrors this. Both currently omit remove events: adjust mocks if status deletion drives UI. Smoke identity (`53`) and browser shim identity (`51`) currently support only `getAuthToken` (plus shim removal), with no `launchWebAuthFlow`/`getRedirectURL`; add deterministic implementations as needed. Do not confuse these mocks with real Google verification.

### `docs/OAUTH-RUNBOOK.md`

**Analog:** `deploy/README.md:11–18` uses numbered actions with an observable success result:
```markdown
## What friends do (30 seconds)

1. Load the extension (chrome://extensions → Developer mode → Load unpacked → the repo folder).
2. Open the side panel → ⚙ → **coach server**: paste the server address
   (e.g. `https://focus-agent-bridge.fly.dev`).
3. **access code**: paste the code you gave them.
4. The brain badge should say **🧠 Claude (API, hosted)**. If it says
   **🔒 wrong access code**, the code is off.
```
Copy the structure, not the hosting instructions. Document one-time public-key creation/private-key handling, derived permanent ID, updating BOTH OAuth clients, exact web redirect, test-user setup, Testing-mode reconnect expectation, and fresh-folder/second-machine verification. Distinguish automated test results from manual Google Console and real-account checks. Do not claim a fresh ID migrates existing extension storage.

## Shared Patterns

- **Auth ownership:** all Google callers use `FA.google`; classify and persist status there, not separately in feature callers. Existing auth code is the structural analog, but no typed taxonomy/state store currently exists.
- **Errors:** Promise rejection at callback boundaries, one bounded 401 retry, and UI copy in the existing chip. Do not map offline/unknown/configuration failures indiscriminately to expired authorization.
- **State:** `chrome.storage.local` plus filtered `onChanged` is the existing cross-context transport. New status reads must be safe during reload and avoid redundant persistence-triggered render loops.
- **Tests:** execute real source with synthetic Chrome/network effects; no live OAuth credentials in automated fixtures. Real school/personal sign-in and Console configuration remain manual verification.

## No Analog Found

| Concern | Role | Data Flow | Reason |
|---|---|---|---|
| Typed OAuth classifier and durable connection status inside `lib/google.js` | service/store | request-response, event-driven | Current code uses generic errors and token-presence booleans; research must define the new semantics. |
| Stable-ID derivation/validation | utility | transform | No existing public-key-to-extension-ID helper; implement from researched algorithm and validate against Chrome. |

## Metadata

**Analog search scope:** tracked root configuration, `lib/`, `sidepanel/`, `scripts/`, `deploy/`, and phase context.
**Files inspected for patterns:** 13 implementation/documentation files; five principal pattern anchors: Google service, panel, VM tests, jsdom smoke, deployment runbook.
**Tracked-source gate:** all existing analogs confirmed using `git ls-files -- <paths>`; no install/runtime mirror paths used.
**Project context:** read root `LEARNINGS.md`; no root `AGENTS.md` or project skills directories found. Only this pattern artifact was written.
**Pattern extraction date:** 2026-09-24. Line numbers refer to the current checkout and may move during execution.
