---
phase: 01-stable-extension-id-oauth-hardening
plan: "02"
subsystem: auth
tags: [chrome-extension, oauth, jsdom, recovery]
requires:
  - phase: 01-01
    provides: Stable identity, validated OAuth callbacks and shared status
provides:
  - Bounded silent recovery shared by JSON and Drive byte requests
  - Account-preserving token invalidation and stale-operation guards
  - Accessible persisted reconnect chip with deliberate recovery
affects: [01-03, 01-04]
tech-stack:
  added: []
  patterns: [request-bound token descriptors, storage generation invalidation, typed sanitized provider failures]
key-files:
  created: []
  modified: [lib/google.js, sidepanel/panel.js, scripts/test-google-auth.js, scripts/smoke-panel.js]
key-decisions:
  - "Keep global AUTH acceptance pending until real-account verification in 01-04."
  - "Preserve selected web door and email hint when invalidating a rejected access token."
requirements-completed: []
requirements-addressed: [AUTH-01, AUTH-03]
plan_head_before: b7f95956de1512497167759e3102b75fd620f736
actuals:
  tokens: 8642
  tasks: 2
  commits: 6
coverage:
  - id: silent-recovery
    description: Bounded silent JSON and binary recovery, account continuity, sanitized errors and races
    requirement: AUTH-01
    verification:
      - kind: unit
        ref: scripts/test-google-auth.js
        status: pass
    human_judgment: false
  - id: reconnect-chip
    description: Real panel terminal failure, persisted reconnect, explicit recovery and restored Docs access
    requirement: AUTH-03
    verification:
      - kind: automated_ui
        ref: node scripts/smoke-panel.js --google-auth
        status: pass
    human_judgment: false
duration: 8min
completed: 2026-09-24
status: complete
---

# Phase 1 Plan 2: Silent Recovery and Reconnect Summary

**Google JSON and Drive downloads now recover silently once, retain the chosen account, and surface confirmed authorization loss through an accessible Reconnect Google chip.**

## Accomplishments

- Centralized bearer requests preserve JSON, null-on-204 and ArrayBuffer responses. A 401 evicts its exact token and retries once; the second 401 evicts the rejected replacement and records reconnect only for an established connection. Ambiguous network failures never replay writes.
- Web invalidation compares the cached token and keeps the selected door and optional identity hint. Web renewal coalesces per generation. Explicit connection, external account changes, token replacement and disconnect supersede pending operations; late failures cannot replace newer successful status.
- Authorization, policy restriction, cancellation, network/server, configuration, resource access and unknown errors retain bounded categories. Both eligible acquisition causes are retained; mixed causes cannot fabricate grant expiry. Provider response text is excluded from errors and status.
- The existing chip renders connected, disconnected and Reconnect Google with matching accessible labels. Storage updates and deletion rerender without identity probes. Pilot consent copy avoids elapsed-time claims or blame; cancellation is quiet; duplicate clicks open one chooser.
- Disconnect clears local metadata and web credentials even if revocation fails. A reloaded Chrome panel silently retrieves the cached token solely for eviction; feature preflight probes also propagate confirmed authorization failure to the shared status.

## Task Commits

1. Task 1 RED: `6c0bf8b` — bounded recovery and request race cases.
2. Task 1 GREEN: `7fd87a7` — shared recovery, categories and credential/generation guards.
3. Task 2 RED: `bfb940c` — actual panel reconnect/reload integration cases.
4. Task 2 GREEN: `b0eb268` — accessible reconnect chip and recovery copy.
5. Task 1 final edge review RED: `6cbd533` — reloaded disconnect and silent-probe status.
6. Task 1 final edge review GREEN: `403f6ea` — cached Chrome eviction and probe state propagation.

## Verification

- `node scripts/test-google-auth.js`: **53/53 passed** using real module code in isolated VM contexts.
- `node scripts/smoke-panel.js --google-auth`: **21/21 passed**, `GOOGLE AUTH PASSED`; fresh full JSDOM boots cover connected, reconnect and disconnected persistence.
- `node scripts/test-background.js`: **14/14 passed**.
- `node scripts/test-panel-boundary.js`: **38/38 passed**.
- `git diff --check` passed; no task commit deleted tracked files. Stub/threat review found no new incomplete behavior or unmodeled endpoint, scope, permission or trust boundary.
- All commands used the supplied bundled Node runtime. Full baseline suites are reserved for 01-04; no unrelated assertions were changed.

## TDD Gate Compliance

All three RED/GREEN pairs have test-only RED commits before implementation. Initial Task 1 executed 47 cases with 14 planned failures; initial Task 2 executed 21 cases with four planned failures; final edge review executed 53 cases with two failures. Each persisted record passed `check tdd-red-evidence` with `RED_EVIDENCE_OK` before production edits. Final results are fully green. No separate refactor commit was needed.

## Deviations from Plan

- **[Rule 1 - Bug] Final edge review required an additional RED/GREEN pair:** reloaded Chrome disconnect lacked an in-memory token descriptor, and existing `isConnected()` preflight callers swallowed authorization failures before an API request. The focused fixes in `403f6ea` complete Task 1's intended cleanup and status contract; no architecture or dependency change.
- Global AUTH requirement checkboxes remain pending under orchestrator direction because real Google/account acceptance belongs to 01-04. Synthetic tests establish handling, not actual seven-day expiry.
- Used the existing main checkout under the orchestrator's temporary explicit `git.allow_default_branch_commits` override; no worktree was created and config.json was excluded from commits.

## Deferred Issues

Seven unrelated full-panel baseline failures remain as recorded in LEARNINGS.md and 01-01-SUMMARY.md. This plan did not run or alter those unrelated regressions. All of this plan's specified automated verification commands ran and passed.

## Known Stubs

None introduced. Optional empty account email is valid when userinfo does not supply one. Live OAuth client registration, managed-account policy, revoked/expired grant and real Chrome identity remain 01-04 acceptance work.

## Next Plan Readiness

01-03 can package the stable identity and publish the owner runbook. 01-04 must verify live Chrome, Google Console registrations and permitted accounts. No hosting or broader OAuth architecture was introduced.

## Self-Check: PASSED

All four implementation files exist; all six task commit hashes were verified. The measured implementation count is six from the persisted ledger before metadata commit; token actuals use realized implementation diff characters divided by four, rounded up.

## Review Fixes — CR-01, CR-02, CR-03

The independent review reproduced three missing edge cases after the original plan completion. Test-only commit `5f7b156` executed 59 auth cases with five targeted failures; `check tdd-red-evidence` returned `RED_EVIDENCE_OK`. Fix commit `dd17693` addresses all three findings without new scopes, dependencies or architecture. The original frontmatter actuals above describe the original execution; these two follow-up implementation commits are additional review work.

- **CR-01:** Explicit disconnect persists `userDisconnected` and blocks subsequent silent identity acquisition, preflight probes and bearer feature calls, including after reload and failed revocation. Only an explicit successful connection clears that intent. First-run/no-record state retains its separate migration behavior.
- **CR-02:** An unexpired cached web token remains usable without optional identity metadata. Silent replacement requires a saved verified email and a verified matching email returned by userinfo for the new token. Missing binding, unavailable userinfo, unverified email and mismatched identity fail closed to deliberate reconnect. A login hint alone is insufficient. Existing renewal fixtures now provide verified synthetic identity; explicit connection remains valid without email metadata and will require explicit reconnection upon expiry.
- **CR-03:** Preflight probes receive the same operation ordering as API requests. Their failed authorization status write checks for newer authenticated success, including after asynchronous storage reads. Successful probes do not independently prove bearer resource access or update `latestSuccess`.

Verification after fixes: **59/59 auth**, **22/22 focused panel OAuth**, **14/14 background**, and **38/38 panel boundary** passed. The panel now also proves disconnected feature activity cannot silently restore the connection. `git diff --check` passed. No full-suite rerun was performed; 01-04 owns final regression and archive rebuild. Global AUTH acceptance remains pending live verification. REVIEW.md was left unchanged for independent recheck.
