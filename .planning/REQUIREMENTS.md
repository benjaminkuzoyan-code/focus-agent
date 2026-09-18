# Requirements: Focus Agent

**Defined:** 2026-09-17
**Last reprioritized:** 2026-09-17 — milestone focus narrowed to "get pilot friends actually testing it," Blackbaud-only
**Core Value:** One tap (Smart Start) gets a student from "can't start" to "working, with structure they can't talk their way out of, and a tutor beside them that never ghostwrites."

## v1 Requirements

**Current milestone = pilot-readiness only.** Everything below is 🎯 pilot-critical. The rest of the original 18-requirement v1 set (Canvas/Classroom/Aeries, cadence, one-bubble coach, checklist-after-reading, finish moment, full real-device QA, accessibility) is real and roadmapped but has been moved to v2 below, on hold until after the first pilot wave — see `.planning/PROJECT.md` Key Decisions for why.

### AUTH (Google OAuth reliability) — 🎯 pilot-critical

- [ ] **AUTH-01**: A student on a school-managed Chrome account can complete Google sign-in — the personal-Gmail fallback door works when the school blocks third-party OAuth apps
- [ ] **AUTH-02**: The extension has a stable ID (manifest `key`), so registered Google OAuth redirect URIs keep working across reinstalls and unpacked reloads
- [ ] **AUTH-03**: A pilot friend's Google authorization doesn't silently break after 7 days — either the OAuth consent screen moves out of Testing mode, or the re-auth step is documented and expected

**Confirmed during Phase 1 planning (2026-09-17):** this isn't hypothetical — neither OAuth door works for a friend's own install today. Chrome derives an unpacked extension's ID from its install path, so every friend gets a different ID than Ben's dev install; the Web-application OAuth client's registered redirect URI and the Chrome-Extension client's registered "Application ID" are both pinned to Ben's current ID. AUTH-02 (manifest `key` + re-pointing both OAuth clients) is the fix.

### INFRA (coach server, real for the pilot) — 🎯 pilot-critical

- [ ] **INFRA-01**: The coach server runs for real — a real Anthropic API key (`ANTHROPIC_API_KEY` or `~/.focus-agent/api_key`), hosted on Ben's Mac mini (`FA_HOST=0.0.0.0`), exposed to the internet via a Cloudflare Tunnel, with one access code minted per pilot friend (`FA_TOKENS` / the `token` CLI helper)
- [ ] **INFRA-02**: The per-code daily call cap's behavior across a Mac-mini restart is a deliberate, documented decision (not an accident) — the in-memory cap resets on any process restart, which is a different failure mode than Fly.io's scale-to-zero but needs the same explicit call

**Decided 2026-09-17:** Mac mini + Cloudflare Tunnel + real API key, not the existing Fly.io `deploy/` scaffolding — see `.planning/PROJECT.md` Key Decisions for the reasoning. The Fly.io path stays available for later if the pilot outgrows one machine.

### PILOT (proof it actually works) — 🎯 pilot-critical

- [ ] **PILOT-01**: The core loop — Blackbaud portal read → ranked list → Smart Start → focus clock → coach chat — verified live with a real friend account, end to end, not just unit-tested. This is the narrow, pilot-blocking slice of what was QA-01 below; the rest of QA-01's checklist (📸/📷, scanned PDF, YouTube captions+frames, fresh-profile install, second-machine Google) stays in v2 until after this first wave.

## v2 Requirements

Deferred to a future milestone. Tracked but not in the current roadmap push. Each item below already has a phase assignment from the original roadmap (see the "was" column in Traceability) — that work isn't lost, just on hold.

### PORTAL (Canvas, Classroom, Aeries) — on hold: pilot is Blackbaud-only for now

- **PORTAL-01**: A Canvas student sees current grades alongside assignments (today: assignments/quizzes only)
- **PORTAL-02**: A Canvas student sees due dates/schedule the way a Blackbaud student already does
- **PORTAL-03**: A Google Classroom student sees grades, materials, and schedule, not just the To-do assignment list — including the under-18 school allow-listing step
- **PORTAL-04**: An Aeries student can connect their portal and see assignments, grades, and schedule from inside their own logged-in session
- **PORTAL-05**: Every portal adapter (Blackbaud, Canvas, Classroom, Aeries) has a fixture test that would have caught the v0.8.17 status-code misread class of bug before shipping

### CLOCK (work/break cadence) — deferred until after first pilot wave

- **CLOCK-01**: A running work sitting moves into a break automatically when the work interval ends, and the student can't skip or extend it
- **CLOCK-02**: Work resumes automatically when the break ends, without the student restarting the sitting

### COACH (one-bubble coach, annotation rule, checklist) — deferred until after first pilot wave

- **COACH-01**: The coach offers a single next-best-action suggestion at a time (one bubble) instead of a standing row of many chips
- **COACH-02**: The text highlighter's ≡ summarize respects the per-assignment annotation rule (off when annotating the passage is the graded work) — matching what 📸/📷 already do. (Bug confirmed live during Phase 1 planning — see PROJECT.md Context "Known issues.")
- **COACH-03**: The checklist is built from the resources actually opened and instructions actually read, not from the assignment type alone

### DONE (finish moment) — deferred until after first pilot wave

- **DONE-01**: Finishing an assignment produces a specific, true one-line debrief reflecting what happened in that sitting, not a generic congratulations

### QA (full real-device verification, accessibility) — deferred until after first pilot wave

- **QA-01-FULL**: The rest of the real-extension verification pass beyond PILOT-01's core-loop smoke test: 📸/📷 capture, a real scanned PDF, a real YouTube tab (captions + frames), attached links opening, fresh-profile install, Google on a second machine
- **QA-02**: The extension has basic accessibility coverage (labels, focus rings, live regions) before any store listing

### Enforcement & Engagement

- **ENGAGE-01**: Tiered site-blocking during a work session (vs. today's negotiate-only nudge) — gated on the open discussion with Ben and his dad (SPEC §5/§14); not scheduled until that decision lands
- **ENGAGE-02**: Streak/gamification layer beyond the single finish-moment debrief

### Distribution

- **DIST-01**: Chrome Web Store listing and review — explicitly deferred; pilot ships as unpacked zips

### Known bugs (found, not yet fixed)

- **BUG-01**: 📸 screen-annotate button overflows its pill shape when tapped with no assignment open — see `.planning/PROJECT.md` Context "Known issues" for the exact lines
- **BUG-02**: (tracked as COACH-02 above) 🖍 crayon toolbar's ≡ summarize ignores the graded-annotation rule
- **BUG-03**: Unconfirmed — the crayon toolbar may not auto-appear on the very first visit to a newly-permitted site opened by Smart Start (registration/tab-open race); needs live testing to confirm

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

Which phases cover which requirements. Current pilot-push requirements point at the reprioritized roadmap; deferred v2 items keep their original phase assignment for when they're pulled back into v1.

| Requirement | Phase | Status | Was (original roadmap) |
|-------------|-------|--------|-------------------------|
| AUTH-01 | Phase 1 | Pending | Phase 1 |
| AUTH-02 | Phase 1 | Pending | Phase 1 |
| AUTH-03 | Phase 1 | Pending | Phase 1 |
| INFRA-01 | Phase 1.5 | Pending | Phase 5 |
| INFRA-02 | Phase 1.5 | Pending | Phase 5 |
| PILOT-01 | Phase 1.5 | Pending | (new — narrowed from QA-01) |
| PORTAL-01 | — | Deferred (v2) | Phase 2 |
| PORTAL-02 | — | Deferred (v2) | Phase 2 |
| PORTAL-03 | — | Deferred (v2) | Phase 2 |
| PORTAL-04 | — | Deferred (v2) | Phase 4 |
| PORTAL-05 | — | Deferred (v2) | Phase 4 |
| CLOCK-01 | — | Deferred (v2) | Phase 3 |
| CLOCK-02 | — | Deferred (v2) | Phase 3 |
| COACH-01 | — | Deferred (v2) | Phase 3 |
| COACH-02 | — | Deferred (v2) | Phase 3 |
| COACH-03 | — | Deferred (v2) | Phase 3 |
| DONE-01 | — | Deferred (v2) | Phase 3 |
| QA-01-FULL | — | Deferred (v2) | Phase 5 |
| QA-02 | — | Deferred (v2) | Phase 5 |

**Coverage:**
- Current v1 (pilot-critical) requirements: 6 total (AUTH-01/02/03, INFRA-01/02, PILOT-01)
- Mapped to phases: 6 ✓
- Deferred to v2 with a preserved phase reference: 13
- Unmapped: 0 ✓

---
*Requirements defined: 2026-09-17*
*Last updated: 2026-09-17 after reprioritizing around pilot-readiness*
