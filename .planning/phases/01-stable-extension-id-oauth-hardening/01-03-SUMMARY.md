---
phase: 01-stable-extension-id-oauth-hardening
plan: "03"
subsystem: auth
tags: [oauth, packaging, chrome-extension, runbook]
requires:
  - phase: 01-01
    provides: Permanent public extension identity
provides:
  - Fail-closed staged identity and credential validation
  - Exact public configuration and non-destructive owner acceptance runbook
affects: [01-04]
tech-stack:
  added: []
  patterns: [pre-ZIP validation, temporary negative fixtures, sanitized path-only diagnostics]
key-files:
  created: [scripts/test-oauth-package.js, docs/OAUTH-RUNBOOK.md]
  modified: [scripts/package-store.sh, package.json]
key-decisions:
  - "Pin package identity to hamjokekeddfckjjfmciillddifhdeda and validate both OAuth clients against source."
  - "Keep every live Chrome/Console/account acceptance row pending until observed against the final archive."
requirements-completed: []
requirements-addressed: [AUTH-01, AUTH-02, AUTH-03]
plan_head_before: 48de0b24d3006572e8a35b4ffb8d49e80547e821
actuals:
  tokens: 6660
  tasks: 2
  commits: 3
duration: 8min
completed: 2026-09-24
status: complete
---

# Phase 1 Plan 3: Package Identity and Owner Setup Summary

**Both package variants now validate permanent public identity and credential exclusion before ZIP creation; the owner runbook records exact public configuration with live acceptance pending.**

## Accomplishments

- Dependency-free CommonJS `scripts/test-oauth-package.js` exports `deriveExtensionId(base64Spki)` and `validatePackageTree(directory)`. The latter returns `{ extensionId, files }`; `--stage DIR` validates a real staged tree, while default invocation runs fixtures.
- Canonical RSA SPKI DER validation rejects absent, malformed/private markers and trailing bytes. Source identity is pinned to `hamjokekeddfckjjfmciillddifhdeda`; staged DER/ID, exact transformed manifest (including Chrome client/scopes/permissions), and Web client must match source.
- Recursive scanning rejects PEM/credential files, private-key markers, client-secret fields (including JSON escapes), and symlinks before following them. Diagnostics reveal paths/reasons only. Fixtures mutate public data and use synthetic marker strings; no private key is read or generated.
- The existing shell allowlist, friends flag and asset checks remain; the new validator runs before ZIP output. Both new OAuth test scripts extend the existing package test chain without dependency/lockfile changes.
- `docs/OAUTH-RUNBOOK.md` includes exact public clients and expected redirect, owner replacement-ID/rebuild instructions, pilot Testing audience, separate-profile retention safeguards and a fully pending real-account evidence table. It distinguishes authorization loss, offline/setup/resource/policy failures, revoked versus elapsed-time evidence, and inherited implicit-flow/local-token-store boundaries.

## Task Commits

1. Task 1 RED: `8c3287c` — staged OAuth package rejection fixtures.
2. Task 1 GREEN: `a98620b` — stable identity and credential-free staged packages.
3. Task 2: `6f279e2` — exact OAuth setup and live acceptance runbook.

## Verification

- `node scripts/test-oauth-package.js`: **35/35 passed**. Both store/friends positive fixtures and 13 negative fixtures per variant exercise the exported validator and nonzero CLI rejection. Temporary cleanup is limited to each test's own `mkdtemp` directory.
- `bash -n scripts/package-store.sh`: passed.
- Plan's runbook consistency command: **Runbook public configuration matches source**.
- `git diff --check`: passed. No task commit deleted tracked files; stub scan found none; no new endpoint, permission, auth architecture or unmodeled trust boundary introduced.
- Final real archives, full regressions and live Chrome/Console checks are assigned to 01-04; no release or live success is claimed here.

## TDD Gate Compliance

The final RED run executed all 35 cases and failed on the missing validator export assertions. Its persisted evidence passed `check tdd-red-evidence` with `RED_EVIDENCE_OK` before implementation. GREEN passed every fixture. No separate refactor was needed.

## Deviations from Plan

- Symlink rejection is an additional fail-closed safeguard inside the planned staged-file boundary, preventing scans from following links outside the build tree.
- Under orchestrator direction, AUTH checkboxes remain pending until real acceptance in 01-04. Existing main checkout uses the explicit temporary default-branch override; config.json is excluded from commits.
- State advanced to plan 4 and roadmap to 3/4. The SDK skipped the legacy progress-bar update because phase scope is unscoped; the parent owns final state/prose normalization.

## Known Stubs

None. Runbook pending fields intentionally belong to 01-04 live/release acceptance, not unimplemented packaging behavior. All verification commands required by this plan ran.

## Next Plan Readiness

01-04 can run full regression/release builds, extract and validate both archives, then obtain real Chrome ID/redirect, owner registration and permitted account evidence. Ben's external action remains pending until these final artifacts are ready. Original-install retention must be recorded before any replacement.

## Self-Check: PASSED

All four declared implementation files exist and all three task commits were verified. Implementation commit count is measured from the persisted ledger before this metadata commit; token actuals are realized diff characters divided by four, rounded up. The parent owns the final consolidated project learnings update.
