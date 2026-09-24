---
phase: 01-stable-extension-id-oauth-hardening
plan: "01"
subsystem: auth
tags: [chrome-extension, oauth, web-crypto, jsdom]
requires: []
provides:
  - Permanent RSA public extension identity
  - Shared Google connection status and per-request token provenance
  - Explicit Chrome and validated personal-account connection through the real panel
affects: [01-02, 01-03, 01-04]
tech-stack:
  added: []
  patterns: [storage-only status reader, per-attempt OAuth state, typed sanitized auth errors]
key-files:
  created: [scripts/test-google-auth.js]
  modified: [manifest.json, lib/google.js, sidepanel/panel.js, scripts/smoke-panel.js]
key-decisions:
  - "Public key derives extension ID hamjokekeddfckjjfmciillddifhdeda; preserve this identity for all pilot packages."
  - "Status is non-secret display metadata; web credentials remain in the existing googleWebToken record."
  - "Keep global AUTH acceptance pending until remaining plans and live Google verification complete."
requirements-completed: []
requirements-addressed: [AUTH-01, AUTH-02, AUTH-03]
plan_head_before: cf1391c3e4668012a8a908f5084a98263eb1933f
actuals:
  tokens: 9449
  tasks: 2
  commits: 4
coverage:
  - id: keyed-identity
    description: Permanent public RSA key with unchanged scopes
    requirement: AUTH-02
    verification:
      - kind: unit
        ref: scripts/test-google-auth.js
        status: pass
    human_judgment: false
  - id: explicit-google-tracers
    description: Real panel Chrome and personal-account connect, reload, storage notification and Docs read
    requirement: AUTH-01
    verification:
      - kind: automated_ui
        ref: node scripts/smoke-panel.js --google-auth
        status: pass
    human_judgment: false
duration: 12min
completed: 2026-09-24
status: complete
---

# Phase 1 Plan 1: Stable Identity and Explicit OAuth Summary

**A permanent manifest key and shared Google status now support explicit Chrome and state-bound personal-account sign-in through the existing panel.**

## Accomplishments

- Generated one RSA-2048 key through OpenSSL with exclusive creation at `focus-agent-signing.pem`, mode 0600. Existing `*.pem` ignore applies; no private bytes were printed, tracked, or used in fixtures. Only public SPKI DER is in the manifest. Derived ID: `hamjokekeddfckjjfmciillddifhdeda`; redirect: `https://hamjokekeddfckjjfmciillddifhdeda.chromiumapp.org/`. Actual Chrome corroboration remains 01-04.
- Added the storage-only `FA.google.status()` contract, sanitized error categories, separate selected-door intent, and token descriptors tied to the request. Existing feature exports and three scopes remain compatible.
- The actual Google chip uses persisted status and a click guard. Two simultaneous clicks share one connection. Rendering and feature requests never escalate to interactive OAuth.
- Web grants require fresh cryptographic state, exact redirect origin/path, no URL credentials/query, unique response fields, a bearer token, and positive finite lifetime. Rejected callbacks make no credential writes or authenticated fetches.
- Preserved selected-web intent after expiry, optional honest account metadata, and prior connection on cancellation; disconnect supersedes a pending connection.

## Task Commits

1. Task 1 RED: `7e296d6` — explicit Chrome connection and actual-panel tracer tests.
2. Task 1 GREEN: `63b0ab1` — keyed identity, shared status and connected panel.
3. Task 2 RED: `fd2710e` — callback rejection and account continuity tests.
4. Task 2 GREEN: `207a4b6` — validated personal OAuth grants and connection generation guard.

## Verification

- `node scripts/test-google-auth.js`: **29/29 passed**, executing real `lib/google.js` in isolated VM contexts. Includes 17 malformed callback cases, both auth doors, interaction policy, identity continuity, coalescing and disconnect race.
- `node scripts/smoke-panel.js --google-auth`: **10/10 passed**, `GOOGLE AUTH PASSED`. Both button handlers use the real production Google module; a second full JSDOM panel boot proves reload persistence.
- Task 1 tracer gate repeated before Task 2: **4/4 VM and 7/7 panel cases passed** at that point.
- Main test script executed exactly as package.json's chain using bundled Node: **89/89 security, 38/38 panel boundary, 14/14 background, 17/17 docops passed**.
- `node scripts/smoke-toolbar.js`: **13/13 passed**.
- Full `node scripts/smoke-panel.js`: **same seven pre-existing failures** recorded in LEARNINGS.md and COVERAGE.md; original assertions preserved.
- `git diff --check` passed; private key ignore/untracked status and 0600 permissions confirmed; task commits contain no file deletions.

## TDD Gate Compliance

Both tasks have RED commits preceding GREEN commits. Task 1 initially failed on missing persisted connection status; Task 2 failed on accepting a callback without state. Both evidence records passed `check tdd-red-evidence` with `RED_EVIDENCE_OK` before production edits. The initial Task 2 test run exposed a hanging async test that exited without a case count; adding a per-case timeout made the harness fail closed, and RED was rerun and verified. No implementation was authorized by that incomplete run.

## Deviations from Plan

- **[Rule 3 - Blocking] npm absent from bundled runtime:** ran the exact package.json test chain directly with Python and bundled Node; no dependency changes or installs.
- **[Rule 2 - Correctness] Requirement completion deferred:** these plan requirements also depend on 01-02–04 and real-account evidence. Per orchestrator direction, global AUTH checkboxes remain pending rather than claiming live acceptance from synthetic tests.
- The run uses the existing checkout on main under the orchestrator's explicit temporary `git.allow_default_branch_commits` override; no worktree was created. The override is excluded from commits and owned by the orchestrator.

## Deferred Issues

The full panel smoke still fails its baseline chunk checkpoint, checkpoint completion, paper mode, worker-ended done view, dev toggle, offline dev write, and clear-chat-on-completion assertions. These are outside OAuth scope and were not weakened or repaired.

## Known Stubs

None introduced. Optional empty email is deliberate when the provider does not return identity metadata. Existing public OAuth client IDs remain unchanged pending owner verification in 01-04; automated tests do not establish their live registration.

## Next Plan Readiness

01-02 can extend centralized recovery, reconnect rendering, bounded retries and cross-context cleanup. 01-03 owns packaging gates/runbook, and 01-04 owns real Chrome ID checks, Google Console setup and permitted account acceptance. Hosting remains outside this phase.

## Self-Check: PASSED

All five declared implementation files exist, the manifest public key parses as RSA-2048 SPKI, and commits `7e296d6`, `63b0ab1`, `fd2710e`, `207a4b6` exist. Measured implementation commit count is 4 from the persisted plan ledger before the metadata commit; actual token estimate is realized diff characters divided by four, rounded up.
