# Phase 1: Stable Extension ID + OAuth Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-17
**Phase:** 1-Stable Extension ID + OAuth Hardening
**Areas discussed:** Stable extension ID, 7-day Testing-mode expiry UX, Personal-Gmail fallback trigger, OAuth production verification scope

**Mode:** `--auto` — Claude selected the recommended option for each area without prompting the user. No AskUserQuestion calls were made.

---

## Stable extension ID

| Option | Description | Selected |
|--------|-------------|----------|
| Generate keypair, private key out of git, Ben manually re-points both OAuth clients via a documented runbook step | Standard manifest `key` approach; the OAuth-client repoint is inherently a manual Google Cloud Console action | ✓ |
| Skip manifest key, accept ID changes on every unpacked reload | Would leave OAuth broken every time the extension reloads during development or a friend reinstalls | |

**Selected:** Generate once, private key out of git, document the manual OAuth-client repoint step.
**Notes:** Auto-selected as the recommended default — matches the documented standard approach from `.planning/research/STACK.md`.

---

## 7-day Testing-mode expiry UX

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit "Reconnect Google" state on the existing Google chip | Extends the existing connect/disconnect chip in `sidepanel/panel.js`; avoids a confusing raw error surfacing inside an unrelated feature (e.g. outline-doc creation) | ✓ |
| Rely on the existing single-retry-then-fail behavior only | Cheaper, but leaves the student facing a raw/generic error with no clear next action | |

**Selected:** Explicit reconnect state on the existing Google chip.
**Notes:** Auto-selected as the recommended default.

---

## Personal-Gmail fallback trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Keep try-chrome-first/fall-back-to-web; special-case the known "disabled for this account" error to skip straight to door 2 | Minimal change to the already-working two-door pattern in `lib/google.js` | ✓ |
| Proactively detect "school managed" account before attempting door 1 | Bigger change, marginal benefit over reacting to the specific known failure | |

**Selected:** Keep the existing pattern; special-case the known error.
**Notes:** Auto-selected as the recommended default.

---

## OAuth production verification scope

| Option | Description | Selected |
|--------|-------------|----------|
| Accept 7-day Testing-mode re-auth for the pilot, paired with a clear reconnect UX | Avoids a multi-week external Google verification review for a 5-person pilot | ✓ |
| Pursue full Google OAuth app verification in this phase | Disproportionate effort/timeline for the current pilot scale | |

**Selected:** Accept 7-day re-auth for now; verification deferred.
**Notes:** Auto-selected as the recommended default — consistent with PROJECT.md's "Store distribution is later and not a concern now" framing.

---

## Claude's Discretion

- Exact copy/placement of the "Reconnect Google" UI state (chip color, tooltip text, whether a coach-adjacent note fires once).
- Whether the manifest-key runbook step lives in a new `docs/` file or an existing one.

## Deferred Ideas

- Full Google OAuth app verification — deferred past this pilot milestone.
- Classroom API allow-listing for under-18 accounts — belongs to Phase 2, not this phase.
