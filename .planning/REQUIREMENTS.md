# Requirements: Focus Agent

**Defined:** 2026-09-17
**Core Value:** One tap (Smart Start) gets a student from "can't start" to "working, with structure they can't talk their way out of, and a tutor beside them that never ghostwrites."

## v1 Requirements

Requirements for this milestone. Scoped to the "Active" gaps already named in `docs/SPEC.md` §23 and `.planning/PROJECT.md`, refined by research findings in `.planning/research/`.

### AUTH (Google OAuth reliability)

- [ ] **AUTH-01**: A student on a school-managed Chrome account can complete Google sign-in — the personal-Gmail fallback door works when the school blocks third-party OAuth apps
- [ ] **AUTH-02**: The extension has a stable ID (manifest `key`), so registered Google OAuth redirect URIs keep working across reinstalls and unpacked reloads
- [ ] **AUTH-03**: A pilot friend's Google authorization doesn't silently break after 7 days — either the OAuth consent screen moves out of Testing mode, or the re-auth step is documented and expected

### PORTAL (Canvas, Classroom, Aeries)

- [ ] **PORTAL-01**: A Canvas student sees current grades alongside assignments (today: assignments/quizzes only)
- [ ] **PORTAL-02**: A Canvas student sees due dates/schedule the way a Blackbaud student already does
- [ ] **PORTAL-03**: A Google Classroom student sees grades, materials, and schedule, not just the To-do assignment list — including the under-18 school allow-listing step
- [ ] **PORTAL-04**: An Aeries student can connect their portal and see assignments, grades, and schedule from inside their own logged-in session
- [ ] **PORTAL-05**: Every portal adapter (Blackbaud, Canvas, Classroom, Aeries) has a fixture test that would have caught the v0.8.17 status-code misread class of bug before shipping

### CLOCK (work/break cadence)

- [ ] **CLOCK-01**: A running work sitting moves into a break automatically when the work interval ends, and the student can't skip or extend it
- [ ] **CLOCK-02**: Work resumes automatically when the break ends, without the student restarting the sitting

### COACH (one-bubble coach, annotation rule, checklist)

- [ ] **COACH-01**: The coach offers a single next-best-action suggestion at a time (one bubble) instead of a standing row of many chips
- [ ] **COACH-02**: The text highlighter's ≡ summarize respects the per-assignment annotation rule (off when annotating the passage is the graded work) — matching what 📸/📷 already do
- [ ] **COACH-03**: The checklist is built from the resources actually opened and instructions actually read, not from the assignment type alone

### DONE (finish moment)

- [ ] **DONE-01**: Finishing an assignment produces a specific, true one-line debrief reflecting what happened in that sitting, not a generic congratulations

### INFRA (hosted coach server)

- [ ] **INFRA-01**: The coach server runs on a real host with a real API key, reachable by pilot friends — not only on the developer's own Mac
- [ ] **INFRA-02**: The per-code daily call cap survives the host's normal restart/scale-to-zero behavior, or that reset behavior is an explicit, accepted decision rather than an accident

### QA (real-device verification, accessibility)

- [ ] **QA-01**: Each core real-extension behavior — chime, 45s stop, mid-sitting reload, 📸/📷 capture, a real scanned PDF, a real YouTube tab (captions + frames), missing/overdue on a live feed, attached links opening, fresh-profile install, Google on a second machine — has been run for real at least once
- [ ] **QA-02**: The extension has basic accessibility coverage (labels, focus rings, live regions) before any store listing

## v2 Requirements

Deferred to a future milestone. Tracked but not in this roadmap.

### Enforcement & Engagement

- **ENGAGE-01**: Tiered site-blocking during a work session (vs. today's negotiate-only nudge) — gated on the open discussion with Ben and his dad (SPEC §5/§14); not scheduled until that decision lands
- **ENGAGE-02**: Streak/gamification layer beyond the single finish-moment debrief

### Distribution

- **DIST-01**: Chrome Web Store listing and review — explicitly deferred; pilot ships as unpacked zips

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| OS-level or hard site-blocking (e.g. Cold-Turkey-style locking) | Out of reach for a Chrome extension and would look like anti-student malware on a school-managed device |
| AI-detection-evasion / "humanizer" tooling for student writing | Directly breaks the tutor-not-ghostwriter rule |
| Shame-based streak mechanics | Research flagged this as the line between "meaningful" and "gimmicky" for teen users; a true one-line debrief is enough for v1 |
| Any answer-reveal escape hatch in the coach | Breaks the server-enforced tutor boundary that's the product's core legal/trust guarantee |
| Sharing student stats with parents/schools | Needs its own legal/privacy research pass before it's even scoped — not a natural extension of the existing debrief |

## Traceability

Which phases cover which requirements. Filled in during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 1 | Pending |
| PORTAL-01 | Phase 2 | Pending |
| PORTAL-02 | Phase 2 | Pending |
| PORTAL-03 | Phase 2 | Pending |
| PORTAL-04 | Phase 4 | Pending |
| PORTAL-05 | Phase 4 | Pending |
| CLOCK-01 | Phase 3 | Pending |
| CLOCK-02 | Phase 3 | Pending |
| COACH-01 | Phase 3 | Pending |
| COACH-02 | Phase 3 | Pending |
| COACH-03 | Phase 3 | Pending |
| DONE-01 | Phase 3 | Pending |
| INFRA-01 | Phase 5 | Pending |
| INFRA-02 | Phase 5 | Pending |
| QA-01 | Phase 5 | Pending |
| QA-02 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 18 total
- Mapped to phases: 18 ✓
- Unmapped: 0 ✓

---
*Requirements defined: 2026-09-17*
*Last updated: 2026-09-17 after roadmap creation (ROADMAP.md)*
