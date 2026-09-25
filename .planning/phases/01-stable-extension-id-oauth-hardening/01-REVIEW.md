---
phase: 01-stable-extension-id-oauth-hardening
reviewed: 2026-09-24T23:54:47Z
reviewed_commit: dd176935313021e383eea966dcfb143cb418caa2
recheck_scope: [CR-01, CR-02, CR-03]
resolved_findings: [CR-01, CR-02, CR-03]
depth: standard
files_reviewed: 9
files_reviewed_list:
  - manifest.json
  - lib/google.js
  - sidepanel/panel.js
  - scripts/test-google-auth.js
  - scripts/smoke-panel.js
  - scripts/test-oauth-package.js
  - scripts/package-store.sh
  - package.json
  - docs/OAUTH-RUNBOOK.md
findings:
  critical: 0
  warning: 0
  info: 0
  total: 0
status: clean
---

# Phase 1: Code Review Report

**Reviewed:** 2026-09-24T23:54:47Z (targeted fix recheck)
**Depth:** standard
**Files Reviewed:** 9
**Status:** clean — all three reported findings resolved

## Summary

The initial standard review covered the Phase 1 source changes from `cf1391c` through `6f279e2`, including the Google module's feature callers, test harness behavior, package validator, and owner runbook. Its three reproduced state/account defects are now resolved at `dd17693`. This follow-up was limited to CR-01, CR-02 and CR-03 and their regression cases; it was not a new broad audit. Current frontmatter counts represent unresolved findings. Original findings below are retained as resolved history. No source files were modified by the reviewer.

The review retains D-03's existing implicit flow and the documented local-token-store boundary. Public client IDs awaiting owner confirmation and the seven pre-existing unrelated panel smoke failures are not findings. No live Google authorization or Console verification was performed.

## Narrative Findings (AI reviewer)

### Fix recheck verdict

All three requested fixes are confirmed addressed by source inspection and executed regressions:

| Finding | Status | Current implementation and executed evidence |
| --- | --- | --- |
| CR-01 | Resolved | `lib/google.js:96,198,244,350` persists and enforces `userDisconnected` before silent identity/API acquisition. Explicit successful connect replaces the marker. Auth case 53 verifies failed revocation, subsequent probes/API calls in original and fresh modules, zero identity/bearer effects while disconnected, and explicit reconnection. Panel case 19 verifies the actual UI remains disconnected during feature activity. |
| CR-02 | Resolved | `lib/google.js:136-139,184-190,226` permits reuse of the still-valid selected token, requires a verified prior email for silent renewal, and rejects missing, denied, unverified or mismatched provider identity before storing/using a replacement. Auth cases 54–56 cover absent binding and unavailable/unverified userinfo, retained prior credentials, no Docs request, reconnect state and deliberate recovery; case 57 preserves use of a valid token with only 30 seconds remaining. Cases 25, 27 and 32 exercise matching binding, mismatch rejection and bounded verified renewal. |
| CR-03 | Resolved | `lib/google.js:237-244,329-336` includes probes in operation ordering and rechecks the success watermark immediately before changing authorization status. Auth case 58 holds the old probe, completes a newer authenticated request, then releases the old failure; the probe returns false and status remains connected. Case 59 preserves reconnect for a current confirmed failure. |

Reviewer executed `node scripts/test-google-auth.js`: **59/59 passed**, and `node scripts/smoke-panel.js --google-auth`: **22/22 passed**, both with positive case counts and exit 0. `git diff --check` passed. The RED commit `5f7b156` is test-only; the source fix is `dd17693`.

No scope, permission, client-ID, manifest-key, packaging or architecture expansion occurred in these fixes. The manifest and package contracts are unchanged; implicit OAuth and existing local credential storage remain. With the current scopes, absent verified identity conservatively requires explicit web reconnect after token expiry, as requested in CR-02, rather than accepting an unbound replacement. Live Google/Console acceptance remains pending and is not implied by this clean code-review verdict.

## Resolved Critical Findings — original review history

### CR-01: Explicit disconnect does not prevent later silent reconnection

**Classification:** BLOCKER (original severity; resolved at `dd17693`)

**File:** `/Users/vanshkumar/Documents/ext_repos/focus-agent/lib/google.js:191-205`

**Related lines:** `lib/google.js:335-352`, `lib/google.js:268-270`; existing callers include `sidepanel/panel.js:613,1720` and `background.js:493`.

**Issue:** `disconnect()` persists a disconnected record, but `getToken(false)` ignores that status and immediately calls Chrome identity again. Removing an access token from Chrome's cache does not remove authorization to mint another one. If revocation fails offline, is denied, or has not completed yet, the next preflight or background feature can silently acquire another token. A successful API call then persists `connected` through `rememberConnection()`. The user's explicit disconnect therefore does not survive subsequent feature activity, including activity after reopening the panel. The current reload smoke only checks a render without feature calls, so it misses this path.

**Reproduction:** In the existing real-module harness, seed `googleAuthState` with a connected Chrome record, let Chrome return a cached/new token, call `await google.disconnect()`, then `await google.getDoc('after-disconnect')`. The observed final status is `connected`; both identity requests are noninteractive. Make only the revocation fetch reject to model the concrete offline-disconnect case, then restore API connectivity; the authorization grant remains available and the same transition occurs. Repeat with a fresh module using the persisted disconnected store to cover reload.

**Fix:** Persist explicit user-disconnected intent and enforce it before all silent acquisition/API/preflight paths. Clear that intent only through explicit `connect()`. Keep legacy/no-status migration distinct if its existing silent behavior must remain. Best-effort provider revocation and exact cache eviction should remain cleanup, not the authority for whether the extension may reconnect. Add a regression covering failed revocation followed by feature/preflight activity in both the original and a fresh module context, asserting no new identity or bearer calls until explicit connect.

**API evidence:** Chrome distinguishes [removing a cached token](https://developer.chrome.com/docs/extensions/reference/api/identity#method-removeCachedAuthToken) from clearing authorization state; its `getAuthToken` can fetch tokens noninteractively when no prompt is necessary.

### CR-02: Silent web renewal can adopt a different account when identity is absent

**Classification:** BLOCKER (original severity; resolved at `dd17693`)

**File:** `/Users/vanshkumar/Documents/ext_repos/focus-agent/lib/google.js:174-186`

**Related lines:** `lib/google.js:148-149`, `manifest.json:89-93`.

**Issue:** Account continuity is enforced only when both the saved email and the newly fetched email are nonempty. An explicit web connection legitimately stores `email: ''` when userinfo supplies no email, then an expired token renews with `prompt=none` and no `login_hint`. Any returned token is accepted, saved, and used by the feature without verifying its account. If the selected account A is no longer the active Google cookie session and another already-authorized account B is available, this can execute writes in B's Docs/Calendar. Even with an old email hint, a failed userinfo response skips the comparison and accepts the token. Missing identity is normal for the current scope set: it requests documents, drive.file and calendar.events, but no identity/email scopes. Preserving the selected door alone does not preserve the selected account.

**Reproduction:** Seed connected web status and `googleWebToken: { access_token: 'chosen-account-A', expires_at: 1, email: '' }`. Return a valid state-bound callback containing a replacement token, and return HTTP 403/no identity from userinfo. Call `getDoc`. The actual module launches a silent URL with no `login_hint`, saves the replacement token and sends it to Docs. The same test with an existing saved email and unavailable userinfo demonstrates that a hint is not verified. Existing tests cover conflicting returned emails, but do not reject unavailable identity.

**Fix:** Fail closed on automatic replacement when continuity cannot be established: retain the chosen web door and expose deliberate reconnect, without adopting or using the replacement token. Within the locked unchanged-scope design, this can conservatively require an explicit chooser for an expired web credential with no verifiable account binding. If an identity mechanism is later available, persist a stable provider identity and require the renewed credential to match it before storage or feature calls. Do not silently add scopes or redesign OAuth as part of this fix. Add absent-identity and unavailable-userinfo cases that assert no replacement bearer reaches Docs/Calendar and that explicit reconnect remains usable.

**Provider evidence:** Google's [userinfo guidance](https://developers.google.com/identity/openid-connect/openid-connect#obtaininguserprofileinformation) explains the identity/email scopes and that fields can be withheld. Google's [OAuth request parameters](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow#redirecting) describe `login_hint` as a hint for selecting a session, not proof of returned identity.

### CR-03: An older preflight failure overwrites a newer successful connection

**Classification:** BLOCKER (original severity; resolved at `dd17693`)

**File:** `/Users/vanshkumar/Documents/ext_repos/focus-agent/lib/google.js:323-329`

**Related lines:** `lib/google.js:232-238`, `lib/google.js:242-246,268-270`.

**Issue:** API requests use `operationCounter` and `latestSuccess` to prevent an old terminal failure from replacing newer successful status. `isConnected()` bypasses this ordering and always calls `markAuthorization()` for an authorization failure in the same connection generation. Routine preflights and API activity overlap in the real panel/worker callers. A delayed preflight can therefore mark `reconnect` after a later authenticated request has already succeeded, producing a false reconnect chip and unnecessary consent. A generation check does not help: successful API activity does not change the generation.

**Reproduction:** Seed connected Chrome status. Start `google.isConnected()` and hold its first Chrome callback. Let a later `google.getDoc('new-success')` obtain another token and complete HTTP 200. Then fail the held callback with `OAuth2 not granted or revoked.` and return a validated `login_required` callback from its web fallback. The real module ends with `googleAuthState.status === 'reconnect'` despite the newer successful request. This was executed against the existing harness and source; no source edits were needed.

**Fix:** Put preflight probes under the same attempt ordering used by bearer requests, and guard their status mutation against a newer successful operation. If a successful probe counts as connection evidence, define and apply that consistently too. Add the exact deferred-callback regression above, asserting the probe can return false while shared status remains connected. This finding is proven within one module; it does not rely on an assumed cross-context event ordering.

## Review evidence and limits

- Used the actual `lib/google.js` through the repository VM harness for the three targeted reproductions. Observed outputs were `disconnect then feature: connected`, `old probe after new success: reconnect`, and renewal without a login hint followed by a Docs bearer request.
- Inspected callback binding, token provenance, retry bounds, storage listeners, reloaded disconnect handling, UI rendering changes, packaging identity/credential gates and the new tests. Chrome's [identity reference](https://developer.chrome.com/docs/extensions/reference/api/identity#method-getAuthToken) explicitly documents the callback's separate token/scopes arguments; the implementation's string-token callback is compatible and is not a finding.
- The parent workflow owns final full regression, archive rebuilds and live acceptance. The original 53 auth / 21 OAuth panel / 35 package cases did not cover these triggers; the fix recheck directly executed the expanded 59 auth / 22 OAuth panel cases described above. Packaging was unchanged by the fixes and was not rerun in this targeted recheck.
- No structural pre-pass or external reviewer evidence was supplied. Project-specific learnings were read; the parent owns their consolidated update.

---

_Reviewer: gsd-code-reviewer_
_Depth: standard_
