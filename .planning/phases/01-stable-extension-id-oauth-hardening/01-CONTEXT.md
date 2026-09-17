# Phase 1: Stable Extension ID + OAuth Hardening - Context

**Gathered:** 2026-09-17
**Status:** Ready for planning

<domain>
## Phase Boundary

A pilot friend on a school-managed Chrome account can complete Google sign-in, and that connection keeps working across reinstalls, reloads, and time. This phase covers: giving the extension a stable ID so registered OAuth redirect URIs don't break, making sure the personal-Gmail fallback door actually works when a school blocks third-party OAuth apps, and giving the student a clear path back in when the Testing-mode 7-day authorization lapses. It does NOT cover Canvas/Classroom/Aeries portal reading (Phase 2/4), the work/break clock (Phase 3), or hosting the coach server (Phase 5).

</domain>

<decisions>
## Implementation Decisions

Gathered in `--auto` mode: Claude selected the recommended option for each gray area below (no user prompts). Decisions and rationale are logged for review.

### Stable extension ID
- **D-01:** Generate an RSA keypair with `openssl`; commit only the public key inside `manifest.json`'s `key` field; keep the private `.pem` out of git (`.gitignore`). Document the one-time manual step of re-pointing BOTH Google OAuth clients — the Chrome-Extension-type client used by `chrome.identity.getAuthToken` and the Web-application client (`WEB_CLIENT_ID` in `lib/google.js`) used by `launchWebAuthFlow` — to the new permanent extension ID, in a short runbook note. — **Reversibility:** costly — **rationale:** once friends have loaded the extension with the new stable ID and Ben has updated both Google Cloud OAuth clients to match, reverting to an unkeyed manifest means every friend's install gets a new random ID again and both OAuth clients need to be repointed a second time.
- **[auto] Stable ID — Q: "Where does the private key live and who updates the OAuth clients?" → Selected: "Generate once, private key out of git, Ben updates both OAuth clients manually via a documented runbook step" (recommended default — this is inherently a manual Google Cloud Console action, not something to automate)**

### 7-day Testing-mode expiry UX
- **D-02:** When both `getChromeToken` and the web-token silent refresh fail with an auth error (not a network error), surface an explicit "Reconnect Google" state on the existing Google chip (`sidepanel/panel.js` ~line 3820, currently shows connected/disconnected) rather than relying on the existing single-retry-then-fail behavior (`lib/google.js` line 134) to surface a raw error to features like outline-doc creation. — **Reversibility:** reversible
- **[auto] Expiry UX — Q: "How should the 7-day Testing-mode lapse surface to the student?" → Selected: "Explicit reconnect state on the existing Google chip, not a raw feature error" (recommended default — avoids a confusing failure inside Smart Start/doc creation when the real cause is an expired grant)**

### Personal-Gmail fallback trigger
- **D-03:** Keep the existing try-chrome-first, fall-back-to-web pattern (`lib/google.js` `getToken()`) rather than proactively detecting "school managed" ahead of time. Add one refinement: when door 1 fails with the specific "Service has been disabled for this account" error (already anticipated in the code's own comments), skip straight to interactive door 2 instead of a doomed retry loop on door 1. — **Reversibility:** reversible
- **[auto] Fallback trigger — Q: "Should the app proactively detect a school-managed account, or keep reacting to door-1 failure?" → Selected: "Keep reacting to door-1 failure; special-case the known 'disabled for this account' error to skip straight to door 2" (recommended default — the existing two-door pattern already works; avoids a rewrite for marginal benefit)**

### OAuth production verification scope
- **D-04:** Do NOT pursue full Google OAuth app verification (multi-week external review) in this phase. Accept the 7-day Testing-mode re-auth as expected pilot behavior for now, made tolerable by D-02's reconnect UX. Revisit verification only if/when distribution grows beyond the personal 5-friend pilot. — **Reversibility:** reversible
- **[auto] Verification scope — Q: "Is full OAuth app verification in scope for this phase?" → Selected: "No — accept 7-day re-auth for the pilot, paired with a clear reconnect UX" (recommended default — verification is disproportionate for a 5-person pilot and already flagged as a later concern in PROJECT.md)**

### Claude's Discretion
- Exact copy/placement of the "Reconnect Google" UI state (chip color, tooltip text, whether a coach-adjacent note fires once) is left to planning/implementation — no specific wording was mandated.
- Whether the manifest-key runbook step lives in a new `docs/` file or an existing one (e.g. `docs/SPEC.md` §13 or a new `RUNBOOK.md`) is left to planning.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product spec (source of truth)
- `docs/SPEC.md` §13 "Google" — existing behavior, the three named OAuth blockers (school-managed accounts, extension-ID/OAuth-client mismatch, Classroom under-18 allow-listing), and the "must never" constraints (never change a student's words, never open a sign-in window on its own from the background)
- `docs/SPEC.md` §0 "Three rules that don't move" — the legal/compliance and privacy constraints that bound any OAuth change

### Research (this milestone)
- `.planning/research/STACK.md` — Gap 1 findings: the manifest `key` approach, RSA keypair generation, re-pointing both OAuth clients, and the newly-surfaced Testing-mode 7-day expiry gotcha (personal-Gmail-tied Cloud project can't use "Internal" consent screen)
- `.planning/research/PITFALLS.md` — Chrome/OAuth review pitfalls and school-managed-account failure points (item 4: Chrome Web Store review and OAuth verification for sensitive scopes)
- `.planning/research/SUMMARY.md` — Phase 1 sequencing rationale (blocks every other Google-dependent phase)

### Existing implementation
- `manifest.json` — current `oauth2` block (Chrome-Extension-type client, scopes: `documents`, `drive.file`, `calendar.events`); no `key` field yet
- `lib/google.js` — the existing "two doors, same token" implementation (`getChromeToken`, `getWebToken`, `getToken`, `disconnect`); the `WEB_CLIENT_ID` constant and its comment already documents the school-blocking scenario this phase hardens
- `sidepanel/panel.js` (~line 3820, ~line 189-233) — existing Google connect/disconnect chip and the `disconnected` retry-diagnostic pattern for portal adapters, useful as a UI precedent for the new reconnect state

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `lib/google.js`'s `getToken(interactive)` — the two-door auth entry point every Google feature already calls; the reconnect-detection and door-2-skip logic should live here, not duplicated per caller.
- `sidepanel/panel.js`'s Google chip (~line 3820) — already renders connected/disconnected state and handles the disconnect click; extend it rather than building a new UI surface.

### Established Patterns
- "Two doors, same token": `chrome.identity.getAuthToken` (Chrome-account door) tried first, `launchWebAuthFlow` with a separate Web-application client (personal-Gmail door) as fallback — already implemented and commented with the exact failure mode (school Workspace disables third-party OAuth) this phase needs to harden.
- Retry-once-then-surface pattern already exists in `lib/google.js` line 134 ("Token expired/revoked: drop it and try once more") — this phase adds a terminal reconnect state instead of letting a second failure bubble as a raw error.
- `sidepanel/panel.js`'s portal-adapter disconnect/retry diagnostic (lines 189-233) is a UI precedent worth reusing stylistically for the new Google reconnect state, for consistency.

### Integration Points
- `manifest.json` — add the `key` field; no other manifest changes needed for this phase.
- `lib/google.js` — add reconnect-state detection and the door-1-error-code special case inside `getToken`/`getChromeToken`/`getWebToken`.
- `sidepanel/panel.js` — extend the existing Google chip rendering to show a distinct "reconnect needed" state.

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond the decisions above — open to standard approaches for implementation details not covered by D-01 through D-04.

</specifics>

<deferred>
## Deferred Ideas

- Full Google OAuth app verification (moving the consent screen to production/"Internal") — explicitly deferred past this pilot milestone (see D-04); revisit if distribution grows.
- Classroom API allow-listing for under-18 accounts — belongs to Phase 2 (Canvas + Google Classroom Read Access), not this phase.

### Reviewed Todos (not folded)
None — `todo.match-phase 1` returned zero matches.

</deferred>

---

*Phase: 1-Stable Extension ID + OAuth Hardening*
*Context gathered: 2026-09-17*
