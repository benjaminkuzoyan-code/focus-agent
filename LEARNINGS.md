# Project Learnings

**2026-09-24 — OAuth account-continuity review**
- Observation: The current Docs/Drive/Calendar scope set may return no userinfo email. A saved login hint cannot establish which account owns a renewed web token, and clearing Chrome's token cache does not enforce the user's disconnect intent.
- Action: Keep explicit disconnect intent in shared status. Permit silent web-token replacement only with a saved verified identity and a verified matching replacement; otherwise preserve valid cached access and require the explicit chooser when renewal is needed.
- Confidence: high

**2026-09-24 — Repository sync**
- Observation: This repository's `main` branch tracks `origin/main` at `benjaminkuzoyan-code/focus-agent` on GitHub.
- Action: Pull from the configured upstream when syncing this checkout; use fast-forward pulls to preserve local history.
- Confidence: high

**2026-09-24 — Google recovery integration**
- Observation: Feature callers use `FA.google.isConnected()` before bearer API calls, and a reloaded panel has no in-memory Chrome token descriptor. Updating only request recovery misses preflight reconnect status and reload-time cache cleanup.
- Action: Preserve auth-status propagation in silent preflight probes and test disconnect against persisted Chrome status in a fresh module context.
- Confidence: high

**2026-09-24 — GSD initialization check**
- Observation: `.planning/` already contains PROJECT.md, REQUIREMENTS.md, ROADMAP.md, and STATE.md. Its September 17 scope narrows the broader product spec to a Blackbaud pilot, prioritizing OAuth and coach hosting (hosting changed to Fly.io on September 24).
- Action: Resume the existing GSD project with `gsd-progress`; preserve its pilot scope when consulting `docs/SPEC.md`.
- Confidence: high

**2026-09-24 — GSD progress reporting**
- Observation: `state-snapshot` returns empty decisions/blockers and `list-todos` returns zero, but STATE.md contains decision and blocker bullets plus three hosting follow-ups. Phase 1 has context but no plans or summaries.
- Action: Read STATE.md's prose when reporting this project's outstanding work; distinguish saved GSD progress from newer Git commits.
- Confidence: high

**2026-09-24 — Pilot hosting decision**
- Observation: The user selected Fly.io for now, superseding the Mac mini + Cloudflare Tunnel approach; all other pilot scope remains approved.
- Action: Plan Phase 1.5 around existing `deploy/` Fly.io scaffolding. Keep always-on/auto-stop and daily-cap persistence as explicit planning decisions.
- Confidence: high

**2026-09-24 — OAuth phase research**
- Observation: `lib/google.js` uses an implicit access-token web flow, not refresh tokens; saved-token presence can outlive token validity, and shared `lastDoor` state can select the wrong cache during overlapping requests.
- Action: Keep token source tied to each request, preserve selected-account intent during recovery, and distinguish authorization failures from connectivity errors when planning reconnect behavior. Verify real OAuth separately from mocked tests.
- Confidence: high

**2026-09-24 — Phase 1 test baseline**
- Observation: At `f1926c5`, the main test command and toolbar smoke pass. Panel smoke has seven existing failures: chunk checkpoint, checkpoint step completion, paper mode, worker-ended done view, dev toggle, offline dev write, and clearing chat on completion. The last conflicts with the newer intentional chat-retention behavior.
- Action: Compare OAuth changes against this baseline; do not claim the entire smoke suite passed or change unrelated product behavior to satisfy stale assertions.
- Confidence: high

**2026-09-24 — Student context storage audit**
- Observation: `assignmentMeta` restores assignment chats, files, steps, and practice tests; `studentSnapshot` caches Blackbaud grades for the selected marking period. Coach context includes four recent grades per class but does not retrieve other assignments' saved threads/files/tests. Heavy assignment memory is pruned after 30 days marked done; teacher feedback has no dedicated normalized field or retrieval path.
- Action: Extend these existing stores when planning longitudinal learning context; explicitly address retention, cross-assignment retrieval, and teacher-feedback ingestion rather than assuming cached portal data provides them.
- Confidence: high
