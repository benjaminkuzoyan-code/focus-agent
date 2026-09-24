# Pilot Google OAuth setup and acceptance

Prepared 2026-09-24. Code and fixture results do not establish live Google acceptance. All Chrome, Console and account observations below are **pending** until recorded against the final archive. Fly.io coach hosting belongs to Phase 1.5 and is outside this runbook.

## Public configuration

| Value | Prepared value | Provenance |
| --- | --- | --- |
| Permanent extension ID (expected) | `hamjokekeddfckjjfmciillddifhdeda` | SHA-256 of the committed `manifest.json` RSA SPKI DER public key; first 128 bits mapped from hex 0–f to a–p by `deriveExtensionId` |
| Chrome Extension OAuth client | `248896287493-2ltb6ivk9v1dkhsn792aa14saogp3br1.apps.googleusercontent.com` | Current `manifest.json` → `oauth2.client_id`; Console registration pending |
| Web application OAuth client | `248896287493-4640r61qu86tcfqabid7v8mcbdk56kjm.apps.googleusercontent.com` | Current `lib/google.js` → `WEB_CLIENT_ID`; separate from the Chrome client |
| Expected web redirect | `https://hamjokekeddfckjjfmciillddifhdeda.chromiumapp.org/` | Constructed from the key-derived ID, with trailing slash; runtime confirmation pending |
| Observed `chrome.runtime.id` / extensions-page ID | **pending** | Record from the prepared friends build in real Chrome |
| Observed `chrome.identity.getRedirectURL()` | **pending** | Record exact runtime return value, including trailing slash |

The manifest's `key` is public and stays identical permanently across standard and friends builds. Chrome documents its use for a consistent extension ID. [Manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)

Plan 01-01 already performed one-time, exclusive RSA-2048 generation. The private file is `focus-agent-signing.pem`, ignored by `*.pem`, with mode 0600 at generation. Keep it under the owner's control; never send it to friends, Google, chat, a release archive or source control. Do not regenerate a key while rebuilding or troubleshooting. Public manifest data is sufficient to package and check the ID; these tools never read the private file. A new key would create a different identity and require a separate migration decision.

## 1. Prepare verified artifacts before owner setup

The executor performs these commands; Ben receives the resulting archive, SHA-256 and verification record.

1. Run the existing `npm test` chain (security, panel boundary, background, docops, real-module Google auth and OAuth package tests), then the phase's relevant smoke checks. If npm is unavailable, execute the exact `package.json` chain with the installed Node/Python runtime; do not install a substitute package manager merely to package.
2. Run `bash scripts/package-store.sh` and `bash scripts/package-store.sh --friends`. Both invoke `node scripts/test-oauth-package.js --stage DIR` on their actual staged tree **before ZIP creation**. This checks permanent identity, exact manifest cleanup, both public clients and credential exclusion. Preserve any failing diagnostics and resolve them before distribution.
3. Confirm both resulting manifests retain the same key/ID and the friends archive contains `build.json` with `{"build":"friends"}`. Record SHA-256 of `dist/focus-agent-0.8.21.zip` and `dist/focus-agent-0.8.21-friends.zip` after all source edits are finished. Existing archives from earlier work are not release evidence.
4. Deliver an extracted friends build for the separate test profile. Rebuild both archives and refresh hashes if either public OAuth client ID changes during owner setup. Keep the public manifest key unchanged.

Final standard archive SHA-256: **pending**. Final friends archive SHA-256: **pending**. Source commit: **pending**.

## 2. Preserve the current installation and observe Chrome identity

1. Before replacing anything, inventory whether the existing installation contains work/settings worth retaining: assignment chat, attached files, checklists, practice tests, focus history and coach settings. Record only “retention needed / none / unknown,” plus the old public extension ID. Do not copy bearer tokens or personal work into this record.
2. Keep the old installation and its local data intact until the stable-ID trial and retention decision are verified. A changed extension ID can have separate storage; this phase provides no automatic storage migration. Never delete the old installation as an OAuth fix.
3. In a **separate Chrome profile**, visit `chrome://extensions`, enable Developer mode if policy permits, choose **Load unpacked**, and select the extracted friends folder containing `manifest.json`. If device policy disallows this, stop and record the policy denial; do not disable school controls.
4. Record the ID shown on the extensions page. The executor can inspect the extension service worker and read only `chrome.runtime.id` and `chrome.identity.getRedirectURL()`; these are public values. Do not dump storage, tokens, authorization URLs or callback fragments. Both observed values must match the prepared values above before proceeding. [Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
5. Reload the extension and repeat those checks. Extract the same verified archive to a second directory and load it in another clean profile or permitted second machine; verify the same ID and redirect. Any reinstall test is confined to the disposable test profile after confirming it has no data to retain. Keep the original profile untouched.

## 3. Ben verifies both Google OAuth registrations

Perform this after artifacts and observed Chrome values are ready. The two clients are separate registrations. Record confirmation without downloading or sharing credentials JSON.

1. Open the owning project in [Google Cloud Console](https://console.cloud.google.com/), then Google Auth Platform → Clients (or APIs & Services → Credentials). Find the exact **Chrome Extension** client from the table. Inspect its **Item ID** and update it to the observed stable extension ID. If Console requires creating a replacement, use the Chrome Extension type and that Item ID. Return **only the new public client ID** to the executor; the executor updates `manifest.oauth2.client_id`, tests and rebuilds. Keep the old registration until old-install retention and transition are settled. [Chrome OAuth registration](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
2. Find the separate **Web application** client matching `WEB_CLIENT_ID`. Under Authorized redirect URIs, register the **exact observed** `chrome.identity.getRedirectURL()` including HTTPS and trailing slash. Preserve any other deliberately used redirects until their owners confirm removal. This extension flow uses the public client ID without a client secret. If the Web client must change, return only its public client ID; the executor updates `WEB_CLIENT_ID`, tests and rebuilds. Never embed a client secret in extension code or send one to friends.
3. Verify the project's Google Docs API, Google Drive API and Google Calendar API are enabled for the existing features. Confirm consent data access matches the three existing manifest scopes: `https://www.googleapis.com/auth/documents`, `https://www.googleapis.com/auth/drive.file`, and `https://www.googleapis.com/auth/calendar.events`. Do not add Classroom scopes in this phase.
4. In Audience, keep the pilot in **Testing**, and privately confirm the intended permitted pilot accounts are test users. Do not record their emails here. Do not request production verification for this five-friend pilot. External Testing authorization can lapse after seven days and require consent again; account and organization restrictions can still prevent access. [Manage App Audience](https://support.google.com/cloud/answer/15549945)
5. Record which client registrations and audience were checked, date, observed ID/redirect and outcome. If replacement client IDs were returned, use only the rebuilt archive/hash for the remaining tests and repeat the Chrome identity check.

## 4. Verify real sign-in and recovery

Use an owned, disposable test document containing neutral sample text. Never use a graded submission or existing student work to test writes.

1. On a permitted normal Chrome profile, open the panel and explicitly tap **connect G**. Complete the Chrome-account consent and confirm **G ✓ connected**. Exercise the extension's Google Doc read and outline creation on the disposable document, then reload the extension/reopen the panel and repeat a read. Record success or the bounded failure category only.
2. On a managed Chrome profile where school/device policy permits personal-account use, explicitly tap connect. When the Chrome account reports the known disabled-service condition, the implementation goes to the personal-account chooser on that click. Select an allowed pilot personal account, complete consent and repeat the owned-document operation. Personal login is not a universal school-policy bypass and does not grant access to school-owned documents. If blocked or no suitable account is available, record **blocked/pending**; do not declare fallback accepted.
3. For recovery, revoke this app's test-account grant through the account's security/third-party access controls, or use a grant known to have expired. Trigger a Google operation; a confirmed authorization loss should produce **Reconnect Google** without a spontaneous interactive prompt. Tap it deliberately, complete consent, confirm connected status and repeat the real owned-document operation. Record whether this was **revoked**, **actual expired grant**, or **synthetic test**. Reload/reopen while in reconnect state and confirm it persists until recovery.
4. Test offline behavior by disconnecting the test profile's network during an operation. Expect an offline/retryable failure, with no automatic sign-in window and no false claim that consent expired. Restore connectivity and retry. Do not replay an uncertain write automatically; inspect the disposable document for its outcome first.
5. Attempt to read a known test resource that the selected account cannot access. Expect a resource-access failure; reconnecting should not be presented as granting new document permissions. Treat disabled APIs, wrong client/redirect and invalid configuration as setup problems to resolve in step 3, distinct from authorization lapse. Stop on policy denial rather than suggesting a workaround. Cancel a chooser once and confirm cancellation stays quiet and does not erase an existing connection.
6. Verify explicit disconnect removes connected/reconnect status, then reconnect by tapping again. Record outcome, date, profile type, archive hash and a sanitized category. Do not record student emails, access tokens, callback URLs, document IDs/content, or screenshots with personal work.

This is access-token renewal plus repeat authorization, **not a refresh-token implementation**. A revoked grant or synthetic clock test does not prove that seven real days elapsed. Natural seven-day observation remains pending until actually observed; Google Testing behavior is expected pilot operation, not an assertion that every token lives seven days.

## Residual architecture

The existing Web door retains Google's implicit access-token flow using `launchWebAuthFlow`; this phase adds callback/state validation and recovery, not a PKCE/backend migration. Google recommends modern authorization alternatives for browser apps. [Client-side OAuth guidance](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow)

The web access token remains in the existing `chrome.storage.local` record; new status metadata does not contain it. Local storage is an extension trust boundary and is exposed to extension content scripts by default. This phase does not migrate the token store or restrict the whole store, which other features use. Never export it for troubleshooting. [Chrome storage access](https://developer.chrome.com/docs/extensions/reference/api/storage)

## Acceptance record — fill only from observed evidence

Record date, profile type (personal/managed/clean test, no account identifier), archive SHA-256 and outcome in every row. Use **pending**, **passed**, **failed** or **blocked**, with a short sanitized explanation. Automated fixtures are separate evidence and cannot close these live rows.

| Check | Status | Date / profile type / build SHA-256 / outcome |
| --- | --- | --- |
| Old-ID work/settings retention inventory; original install preserved | pending | pending |
| Final standard and friends archives inspected and hashed | pending | pending |
| Real Chrome ID + exact redirect match prepared public values | pending | pending |
| Same ID/redirect after reload and second directory/profile or machine | pending | pending |
| Chrome Extension client Item ID confirmed by owner | pending | pending |
| Separate Web client exact redirect confirmed by owner | pending | pending |
| APIs, unchanged scopes and Testing audience confirmed | pending | pending |
| Chrome-account consent + real owned-document operation | pending | pending |
| Permitted managed-profile personal fallback + real document operation | pending | pending |
| Connected status and usable access after reopen/reload | pending | pending |
| Revoked/expired grant → persisted reconnect → deliberate consent → restored access | pending | pending; specify revocation versus actual expiry |
| Offline, resource denial, setup/policy failure and cancellation distinguished | pending | pending |
| Explicit disconnect and deliberate reconnect | pending | pending |
| Seven elapsed days observed naturally | pending | pending; never substitute a revoked/synthetic grant |

AUTH-01, AUTH-02 and AUTH-03 remain pending at phase level until the required live evidence is reviewed. Natural elapsed-time evidence is reported separately from the permitted revoked-grant recovery test.
