---
phase: "01"
slug: stable-extension-id-oauth-hardening
status: blocked
threats_open: 3
asvs_level: 1
created: "2026-09-24"
---

# Phase 1 — Security

Implementation mitigations verified at ASVS level 1. Three high-severity register entries remain open solely for mandatory external acceptance; this report does not approve Phase 1 completion. The independent code review is clean after its three findings were fixed.

## Trust Boundaries

| Boundary | Data crossing |
|---|---|
| Google OAuth callback to extension | Untrusted callback fields and bearer credential |
| Extension contexts to shared local storage | Selected-account intent, token cache and status |
| Source to release ZIP | Public identity/configuration and distributable files |
| Owner Console and managed account to acceptance record | Public IDs and sanitized observed outcomes |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Evidence | Status |
|---|---|---|---|---|---|---|
| T-01-01 | Spoofing | getWebToken callback | high | mitigate | lib/google.js acquireWebToken validates random state, exact redirect and unique callback fields; auth tests. | closed |
| T-01-02 | Information disclosure | Private key/status/UI | high | mitigate | Public manifest key only; private PEM independently checked ignored, untracked and mode 0600; bounded status/error fields. | closed |
| T-01-03 | Denial of service | Connect actions | medium | mitigate | pendingConnect/pendingWeb plus pending click guard; explicit-only interactive calls; panel tests. | closed |
| T-01-SC | Tampering | Existing restored test dependency | high | mitigate | Existing locked jsdom 25.0.1 audit OK; no package-lock dependency change. | closed |
| T-01-04 | Information disclosure | Inherited googleWebToken local store / implicit flow | medium | accept | Accepted inherited boundary under D-03; see Accepted Risks below and owner runbook. | closed |
| T-01-05 | Spoofing | api/forgetToken | high | mitigate | Per-request token/door descriptors, matching invalidation, verified account binding on renewal; CR-02 resolved. | closed |
| T-01-06 | Denial of service | Silent recovery | medium | mitigate | Two-attempt 401 loop, silent feature acquisition, no ambiguous network write replay. | closed |
| T-01-07 | Information disclosure | Status and chip errors | high | mitigate | Sanitized typed errors and storage-only bounded status; panel textContent; malformed callback tests. | closed |
| T-01-08 | Tampering | Late connect/disconnect response | medium | mitigate | Connection generation/storage listeners, explicit disconnect intent, ordered probes; CR-01/03 resolved. | closed |
| T-01-09 | Elevation of privilege | Existing Docs operations | high | mitigate | Scopes and feature methods unchanged; 38 boundary tests pass. | closed |
| T-01-10 | Tampering | Packaged manifest | high | mitigate | Pinned expected ID, exact DER/source manifest/client comparison and negative fixtures. | closed |
| T-01-11 | Information disclosure | Release archive | high | mitigate | Package allowlist and pre-ZIP credential/symlink scanner; both actual archives verified. | closed |
| T-01-12 | Spoofing | OAuth registration | high | mitigate | OPEN: owner must confirm both Google client registrations against actual Chrome ID/redirect. | open |
| T-01-13 | Repudiation | Acceptance evidence | medium | mitigate | Runbook distinguishes derived values and automated results from pending live observations. | closed |
| T-01-14 | Tampering | Final release/configuration | high | mitigate | Both final extracted trees validated; auditor independently compared archive bytes and SHA-256. | closed |
| T-01-15 | Spoofing | Wrong registered client/redirect | high | mitigate | OPEN: real Chrome identity and both Console registrations are unobserved; 01-04 Task 2 remains blocking. | open |
| T-01-16 | Information disclosure | Live acceptance record | high | mitigate | Runbook records public configuration/hashes and sanitized outcomes only; no account/token/document evidence collected. | closed |
| T-01-17 | Elevation of privilege | Managed account policy | high | mitigate | OPEN: permitted managed-profile/personal-account live acceptance remains pending; no policy bypass authorized. | open |

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---|---|---|---|---|
| AR-01 | T-01-04 | Preserve the existing implicit web flow and googleWebToken local-storage boundary under locked D-03; no new token copies or scopes. The runbook documents the inherited boundary. This is not a claim of a redesigned confidential-token backend. | Existing phase decision D-03 and authored plan disposition | 2026-09-24 |

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open high | Method |
|---|---|---|---|---|
| 2026-09-24 | 18 | 15 | 3 | gsd-security-auditor L1 source review and independent final ZIP inspection; orchestrator recorded existing accepted risk |

The auditor independently verified 299 store files and 300 friends files, exact source/manifest identity, expected build flag/assets, and credential exclusions. Final hashes:

- Store: `6d2816a47fb918d6f57fa2914b6e16316997e7e2d30b902af0c710d30c76fe75`
- Friends: `5dd2a53b5a6d559cff68f8ffc36352f33d6693929316eaa8a5b20eb2b4dba730`

## Sign-Off

- [x] All threats have a disposition.
- [x] Accepted inherited risk documented.
- [ ] All blocking threats closed: owner/live checks T-01-12, T-01-15 and T-01-17 pending.
- [ ] Phase security acceptance verified.

Continue the prepared 01-04 Task 2 owner checkpoint using docs/OAUTH-RUNBOOK.md. Do not advance to Phase 1.5 or mark AUTH requirements complete until required observations are recorded and open entries reverified.
