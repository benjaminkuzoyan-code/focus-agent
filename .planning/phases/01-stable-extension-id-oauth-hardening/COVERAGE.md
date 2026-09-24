# Phase 1 coverage and planning evidence

Scope: harden the existing Chrome extension's two Google OAuth doors, permanent identity and reconnect behavior. Fly.io hosting remains Phase 1.5. No new app/database, Classroom API expansion, production OAuth verification, or unrelated deferred UI repair is planned.

## API capability decisions

The capability surface is the existing identity integration and its current Docs/Drive/Calendar callers, not every product Google offers. Each door independently supports explicit acquisition, silent acquisition, invalidation, failure classification and disconnect. Opt-outs below follow the approved phase boundary.

| capability | decision | reason |
|---|---|---|
| Chrome identity.getAuthToken interactive | INTEGRATE | Existing explicit connection, 01-01. |
| Chrome identity.getAuthToken silent/cache renewal | INTEGRATE | Existing feature/background access with classified recovery, 01-02. |
| Chrome identity.removeCachedAuthToken | INTEGRATE | Evict exactly the request's Chrome token, 01-02. |
| Chrome identity.launchWebAuthFlow interactive | INTEGRATE | Permitted personal-account fallback with state/redirect checks, 01-01. |
| Chrome identity.launchWebAuthFlow noninteractive | INTEGRATE | Existing web authorization renewal; stays silent and preserves selection, 01-02. |
| Chrome identity.getRedirectURL | INTEGRATE | Exact callback validation plus owner registration evidence, 01-01/04. |
| Chrome identity.clearAllCachedAuthTokens | OPT-OUT | Per-request invalidation/disconnect avoids broad cache reset; no account-management expansion authorized. |
| Chrome identity.getAccounts | OPT-OUT | No account enumeration or additional account-selector system in this pilot. |
| Chrome identity.getProfileUserInfo | OPT-OUT | No identity.email permission or profile-scope expansion; optional existing web userinfo remains sufficient for display. |
| Chrome identity.onSignInChanged | OPT-OUT | Provider failures plus shared storage state drive the bounded reconnect path; Chrome profile monitoring is outside the requirement. |
| Google authorization endpoint response_type=token | INTEGRATE | Preserve locked existing flow; unpredictable state, exact redirect and payload validation, 01-01. |
| Google authorization prompt=none | INTEGRATE | Silent web renewal, with classification and explicit reconnect on authorization loss, 01-02. |
| Google authorization select_account consent | INTEGRATE | Only explicit connect/reconnect; selected-account continuity retained, 01-01/02. |
| Existing Google userinfo lookup | INTEGRATE | Best effort optional display metadata; no stale email identity claim, 01-01. |
| Existing Google token revocation endpoint | INTEGRATE | Best-effort disconnect with unconditional local cleanup, 01-02. |
| Authorization code/PKCE exchange, refresh-token endpoint | OPT-OUT | This phase preserves existing two-door architecture; no backend/client secret or new grant system. Legacy limitation documented. |
| Token introspection/tokeninfo and OIDC ID-token validation | OPT-OUT | Not consumed by the existing integration; no new identity/scopes requirement. |
| Existing Docs get/create/batchUpdate operations | INTEGRATE | Preserve feature contracts and apply shared auth recovery; do not expand student write authority. |
| Existing Drive files/list/comments/media operations | INTEGRATE | Preserve JSON feature contracts and bring binary downloads into the shared recovery policy. |
| Existing Calendar event creation | INTEGRATE | Preserve operation and shared silent recovery; no ambiguous network replay. |
| Additional Docs/Drive/Calendar capabilities | OPT-OUT | AUTH requirements concern reliability of existing consumers, not a new Google feature inventory. |
| Classroom/Slides/Sheets/Gemini integrations | OPT-OUT | Explicitly deferred/other phases; current pilot remains Blackbaud. |
| OAuth production verification / expanded audience | OPT-OUT | D-04 explicitly retains Testing for the five-friend pilot. |

## Plan dependencies and ownership

| Plan | Wave | Needs | Creates | Checkpoint |
|---|---|---|---|---|
| 01-01 | 1 | Existing extension and restored locked jsdom | Permanent key; token/status interfaces; connected/fallback UI path; VM and focused real-panel harness | No |
| 01-02 | 2 | 01-01 interfaces/harness | Silent recovery, provenance/continuity, live reconnect chip | No |
| 01-03 | 2 | 01-01 key and public interfaces | Package validator, required test wiring, exact owner runbook | No |
| 01-04 | 3 | 01-02 and 01-03 complete | Reviewed final archives and real Console/account acceptance record | Final owner action only |

Wave 2 file ownership is disjoint: 01-02 owns lib/google.js, panel.js and auth/panel tests; 01-03 owns packaging validator/script, package.json and runbook. Release packaging/tests run in 01-04 after both finish, so concurrent incomplete snapshots cannot be accepted. No plan changes hosting or student/developer policy.

Discovery used existing current research and tracked code (Level 1 verification already performed by research); no new dependency choice. No history summaries, codebase map, graph or project skills existed. Estimate calibration: factor 1, sample_count 0, confidence low. UI gate supplied frontend:false/block:false; no UI-SPEC requirement. Nyquist false; meaningful regression remains required. No schema files/ORM changes exist, so no schema push applies.

Assumption-delta scan detected fallback: decision **no-change**, primary noun **shared Google auth coordinator**. Both doors already exist; request token provenance and selected-door metadata strengthen that abstraction without a second account subsystem. This brownfield phase is not a new-project Walking Skeleton; no app/database/deployment scaffold is generated.

## Flagged edge assumptions — exact probe disposition

Source: `/tmp/focus-auth-edges.json`, deterministic report supplied by the orchestrator. Applicable: 3; resolved: 0; unresolved: 3; explicit: 0; backstop: 0. No row was auto-resolved, dismissed or converted into a fabricated backstop check.

| Requirement | Category | Status | Verification / resolution / reason | Flag carried in |
|---|---|---|---|---|
| AUTH-01 | unclassified | unresolved | null / null / null; probe: unclassified — review manually | 01-01 flagged_assumptions; real policy/account feasibility in 01-04 |
| AUTH-02 | unclassified | unresolved | null / null / null; probe: unclassified — review manually | 01-03 flagged_assumptions; actual identity/Console evidence in 01-04 |
| AUTH-03 | unclassified | unresolved | null / null / null; probe: unclassified — review manually | 01-02 flagged_assumptions; actual grant/reconnect evidence in 01-04 |

Auth callback/error/race fixtures are independently authored acceptance tests from context/research. Their existence does not change the supplied classifier's unresolved results. Research A1 (old-ID local data retention), A2 (owner/account availability), actual error wording and legacy implicit-flow limitation remain visible in plans/runbook.

## Prohibition recall and precision

No phase SPEC supplied prohibitions; fallback prose recall was used. Raw candidates considered per requirement included correctness, stale cache, retries, state validation, wrong door, private-key leakage, callback logs, policy-bypass messaging, old-data deletion, consent blame, permanent-access promises and misleading live-proof claims. Routine correctness candidates moved to task acceptance; OWASP state/CSRF, cryptography, token disclosure and generic consent/security candidates are canon referrals to `$gsd-secure-phase` and the ASVS L1 threat registers, not duplicate prohibition rows.

Three bespoke candidates survived precision and were projected with the installed `probe-core.cjs` `projectProhibitions` serializer. They remain descriptor-less `status: unresolved` in must_haves.prohibitions, therefore **flagged-unverified**, with no check_kind/check_target/check_rule/fixture or fabricated machine proof:

1. AUTH-01 → 01-01: personal Gmail must not be presented as permission to bypass school policy or view documents the account cannot access.
2. AUTH-02 → 01-03: the old installation/student work must not be discarded to make new-ID acceptance appear successful.
3. AUTH-03 → 01-02: expected repeat consent must not blame the student or promise permanent authorization in Testing.

Equality: 3 edge items = 3 flagged assumptions; 3 kept prohibitions = 3 authored unresolved prohibition items. Verification must retain their unverified disposition until properly reviewed; ordinary passing tests cannot silently mark them green.

## Baseline and command grounding

Bundled Node: `/Users/vanshkumar/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`. Bundled pnpm wrapper: `/Users/vanshkumar/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm`. Python3, OpenSSL, bash, zip/unzip are available. npm executable is absent. The orchestrator restored exact jsdom 25.0.1 from package-lock with scripts disabled, verified registry/upstream/integrity, removed temporary manager artifacts and confirmed package.json/package-lock.json unchanged. No install is left in the plans. See research audit for provenance.

Before source changes, orchestrator reported existing test chain passing: security, panel boundary (38), background (14), docops. Toolbar smoke passed ALL PASSED. Unfiltered panel smoke has seven existing failures: chunk checkpoint posted; checkpoint marks step; paper mode; worker-ended done view; developer toggle; offline developer write; completed-assignment chat clearing (newer product behavior intentionally preserves chat). These are baseline observations, not blanket exemptions: compare the final unfiltered results and investigate newly introduced regressions.

01-01 creates `scripts/smoke-panel.js --google-auth`: actual full panel boot/source with focused OAuth assertions, positive case count, explicit GOOGLE AUTH PASSED and nonzero failure/zero-case exit. That is the required UI integration gate; unrelated historical assertions remain in the unfiltered suite. New test/validator paths are explicitly produced before any dependent invocation. No command pretends to test real OAuth.

## Multi-source audit

| SOURCE | ID | Feature / constraint | Plan | Status |
|---|---|---|---|---|
| GOAL | Phase 1 | Managed-profile sign-in and continuity across reinstalls, reloads and time | 01-01–04 | COVERED |
| REQ | AUTH-01 | Permitted personal fallback works on friend's install | 01-01,02,04 | COVERED |
| REQ | AUTH-02 | Permanent public key, stable identity and redirects | 01-01,03,04 | COVERED |
| REQ | AUTH-03 | Document expected Testing reauth and visible recovery | 01-02–04 | COVERED |
| CONTEXT | D-01 | OpenSSL pair, public manifest key, private exclusion and owner both-client update | 01-01,03,04 | COVERED |
| CONTEXT | D-02 | Existing chip reconnect only for confirmed eligible auth failures | 01-02,04 | COVERED |
| CONTEXT | D-03 | Chrome-first, disabled-account explicit web shortcut, selected-web continuity | 01-01,02,04 | COVERED |
| CONTEXT | D-04 | Keep Testing; no full production verification | 01-02–04 | COVERED |
| RESEARCH | R-01 | Preserve native stack, shared coordinator and current scopes | 01-01,02 | COVERED |
| RESEARCH | R-02 | Per-attempt crypto state, exact redirect, valid token/type/lifetime | 01-01 | COVERED |
| RESEARCH | R-03 | Selected door separate from invalid token; optional honest email | 01-01,02 | COVERED |
| RESEARCH | R-04 | Per-request token provenance and concurrent invalidation | 01-02 | COVERED |
| RESEARCH | R-05 | Silent-only feature/worker recovery, no prompt storms | 01-01,02 | COVERED |
| RESEARCH | R-06 | One 401 retry, terminal auth state and disconnect races | 01-02 | COVERED |
| RESEARCH | R-07 | Network/cancel/configuration/resource/unknown distinction | 01-01,02 | COVERED |
| RESEARCH | R-08 | Shared status, reload correctness and no render/probe write loop | 01-01,02 | COVERED |
| RESEARCH | R-09 | Drive binary path shares auth recovery | 01-02 | COVERED |
| RESEARCH | R-10 | Source/staged/archive key equality and private-material exclusion | 01-03,04 | COVERED |
| RESEARCH | R-11 | Actual Chrome-derived ID, both client registrations, replacement clients | 01-03,04 | COVERED |
| RESEARCH | R-12 | Non-destructive old-install/data handling and actual audience/policy limits | 01-03,04 | COVERED |
| RESEARCH | R-13 | Testing grant versus token expiry; no exact client seven-day timer | 01-02–04 | COVERED |
| RESEARCH | R-14 | Real-source automated harness plus separate real-account verification | 01-01–04 | COVERED |
| RESEARCH | R-15 | Sanitized state/UI/logs; inherited local-store and implicit-flow limitations | 01-01–03 | COVERED |
| RESEARCH | R-16 | Internal security review and complete package before owner checkpoint | 01-04 | COVERED |

All in-scope items have concrete tasks. COVERED means planned, not implemented or verified. Deferred production review, Classroom allow-listing/portals, Fly.io hosting and unrelated UI bugs are exclusions, not unplanned gaps.
