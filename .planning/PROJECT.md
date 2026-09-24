# Focus Agent

## What This Is

Focus Agent is a Chrome side-panel extension for a high-school or college student who wants to do well and can't get started. It reads the student's own school portal (Blackbaud today; Canvas, Google Classroom, and Aeries planned/partial), picks the one assignment to start, opens what's needed, runs a focus clock with real structure, and puts an AI coach beside the student that knows the assignment. The coach explains, checks, and quizzes — it never does the work. Currently at v0.8.21, in pilot with the founder (Ben) and about to expand to 4–5 friends he's onboarding in person.

## Core Value

One tap (Smart Start) gets a student from "can't start" to "working, with structure they can't talk their way out of, and a tutor beside them that never ghostwrites." If the clock's structure, the tutor boundary, or the portal-reading promise breaks, nothing else matters.

## Requirements

### Validated

<!-- Marked ✅/👁 in docs/SPEC.md — built and at least smoke-tested or proven by an automated test. -->

- ✓ Blackbaud/myPoly portal read: assignments, instructions, grades, schedule, topics, attached links/files, whole school year including finished work — existing (v0.8.17–v0.8.19)
- ✓ Assignment list ranked by urgency with a pinned missing/overdue section and a 5-day overdue grace window before work goes stale — existing (v0.8.20, smoke-tested)
- ✓ Smart Start: opens assignment + attached resources in tabs, parks distractions, proposes sitting length, starts clock, briefs the coach — existing (core flow checked by hand)
- ✓ Focus clock with hard planned-end behavior (chime once, amber ring, +5/+10/done/stop with 45s countdown), quiet-time watchdog, alarm persistence across reload/restart — existing (`test-background.js`, 14 cases)
- ✓ Checklist generation from assignment instructions, editable and never emptied by a failed build — existing
- ✓ Coach chat scoped to the assignment (files, checklist, doc text, grades, session stats) in tutor mode only, with a reply length cap and silent-unless-spoken-to default — existing (v0.8.19, v0.8.21; `security_tests.py`, smoke tests)
- ✓ Explain / Check my draft tutor tools — existing
- ✓ Highlight → annotate/summarize/ask with the assignment-aware annotation rule (graded annotations get no help doing the annotation) — existing for 📸/📷 (v0.8.17)
- ✓ 📸 Screenshot annotate and 📷 photo upload, assignment-aware, transcribes and describes figures — existing (v0.8.17)
- ✓ Scanned/image-only PDF pages read by eye via pdf.js render → coach transcription — existing (v0.8.18)
- ✓ Practice test / quiz me / flashcards / study plan built from the student's own material — existing
- ✓ YouTube video summaries from captions, with an optional frames toggle — existing (v0.8.18)
- ✓ Google Docs connect, doc read, outline-doc creation, MLA formatting — existing
- ✓ Distraction watcher (negotiates, doesn't block) during a running session — existing
- ✓ Done flow: minutes vs. guess, one-line debrief, next pick — existing
- ✓ Stats view and Classes view (Blackbaud only) — existing
- ✓ Coach server security guarantees: tutor mode forced for every non-dev code, writing methods refused 403 before any model call, code-gated, no request text in logs, daily call cap, chrome-extension-only origins — existing, 75 passing cases in `security_tests.py`
- ✓ Developer mode gated to Ben's own code, absent from the friends build — existing
- ✓ Friends build pipeline (`npm run package:friends`) strips developer controls and runs the four test suites — existing, never installed on a fresh Chrome profile yet

### Active

<!-- Reprioritized 2026-09-17: current milestone goal is "get pilot friends actually testing it," Blackbaud-only. Items marked 🎯 PILOT are what's in scope now; everything else is real, roadmapped work that's deliberately on hold until after the first pilot wave. -->

**🎯 Pilot-critical (in progress now):**
- [ ] Google OAuth actually works on a friend's own install: stable extension ID via manifest `key`, both Google OAuth clients (Chrome-Extension type + Web-application type) re-pointed to it, personal-Gmail fallback door confirmed working end to end. Confirmed broken today — see Key Decisions.
- [ ] Coach server reachable for real: real Anthropic API key configured as a Fly.io secret, hosted on Fly.io, one access code minted per friend.
- [ ] Core pilot loop verified live on Blackbaud with a real friend account: portal read → ranked list → Smart Start → focus clock → coach chat, end to end, not just unit-tested.

**⏸ Deferred until after the first pilot wave (still real, still roadmapped):**
- [ ] Work/break cadence: app-enforced 15-minute-work / 5-minute-break cycle the student can't skip or extend
- [ ] One-bubble coach: replace the current chip row with a single next-best-action bubble that advances as work progresses
- [ ] Text highlighter's ≡ summarize respects the assignment-aware annotation rule (currently always on, unlike 📸/📷 which already obey it) — plus the 📸 button's text-overflow bug found 2026-09-17 (see Context)
- [ ] Checklist is genuinely built *after* resources are opened and instructions are read, not from assignment-type rules
- [ ] Google Classroom grades, materials, and schedule (needs Classroom API + school allow-listing for under-18 accounts) — **on hold: pilot is Blackbaud-only for now**
- [ ] A real "finish" moment when an assignment is done (streak, full-screen beat, a line that lands) — design pending first-tester feedback
- [ ] Aeries adapter (not built — plan: DevTools session on a friend's Student Portal login) — **on hold: pilot is Blackbaud-only for now**
- [ ] Canvas grades/schedule (assignments/quizzes exist but never run on a real account) — **on hold: pilot is Blackbaud-only for now**
- [ ] Adapter fixtures and a `lib/priority.js` ranking unit test (current test gap)
- [ ] Full real-extension verification pass beyond the pilot-critical smoke test: 📸/📷 capture, a real scanned PDF, a real YouTube tab (captions + frames), attached links opening, fresh-profile install, Google on a second machine
- [ ] Accessibility pass (labels, focus rings, live regions) before any store listing

### Out of Scope

- Blocking social media (YouTube/TikTok/Instagram) during the work clock, instead of only negotiating — open discussion with Ben and his dad, not decided; ship only after that conversation, per SPEC §5/§14
- Chrome Web Store distribution — explicitly deferred; pilot ships as "load unpacked" zips to friends
- Any feature that can't stay legal in every US state or that gives a school a reason to act against a student (bypassing a school control, sharing a password, reading beyond what the student's own login already sees) — hard product boundary, not a roadmap item to schedule

## Context

- Chrome side-panel extension + a small Python (stdlib `http.server`) coach server (`bridge/coach_server.py`) that holds the AI key and never stores requests. Use the existing Fly.io scaffolding in `deploy/` (`Dockerfile`, `fly.toml`, README) for the pilot. The user selected Fly.io on 2026-09-24, superseding the earlier Mac mini + Cloudflare Tunnel approach.
- Per-portal adapters are reverse-engineered, student-session-only API clients normalized into one assignment shape (`adapters/schema.js`); Blackbaud/myPoly is the only fully-proven one. **Pilot v1 assumes Blackbaud only** — Canvas/Classroom/Aeries friends wait for a later wave.
- Pilot audience: Ben plus 4–5 friends he onboards in person. First wave is Blackbaud (Poly) only; Canvas/Classroom/Aeries friends are a later wave once those adapters are ready.
- `docs/SPEC.md` is the source of truth for product behavior — reviewed by Ben by voice on 2026-09-13, with his direction marked 🎯 (decided) or 💬 (to discuss) inline. Code and tests are built to match it; this PROJECT.md and the roadmap should stay traceable back to it.
- Status legend carried over from the spec: ✅ proven by an automated test, 👁 checked by hand in the browser harness, ⚠️ implemented but never run for real, ❌ not built.
- Known unresolved product question (§5/§14): negotiate vs. block distracting sites during a work session — not yet decided.

**Known issues found during Phase 1 planning (2026-09-17), not yet fixed:**
- 📸 screen-annotate button ([sidepanel/panel.js:1985-1987](sidepanel/panel.js:1985)): tapping it with no assignment open sets the small pill-shaped button's text to the full sentence "open an assignment first" — the button has no max-width/no-wrap ([sidepanel/panel.css:76-79](sidepanel/panel.css:76)), so it visibly overflows the narrow side-panel header. Cheap CSS/JS fix, deferred until after the pilot push.
- 🖍 crayon toolbar's ≡ summarize doesn't apply the graded-annotation rule the way 📸/📷 already do (this is requirement COACH-02, now deferred — see Requirements).
- Unconfirmed, needs live testing: the crayon toolbar's auto-registration for a newly-permitted site (`syncToolbarScript` in `background.js`) isn't awaited before Smart Start opens that site's tab, so the toolbar may not appear on the very first visit to a new site even though the coach's own tip message says it will be there.

## Constraints

- **Legal/Compliance**: Must be legal in every US state and give no school a reason to act against a student for using it — only reads what the student's own login can already see, never bypasses a school control, never shares a password. Any feature that can't meet this is cut, not shipped.
- **Privacy**: Portal cookies and passwords never leave the browser; coach requests carry only what the feature needs, are never stored server-side, and nothing is sent without a coach code. Never sent anywhere, ever: cookies, passwords, name, student id, email, teacher contact details, the calendar feed link.
- **Product policy (tutor, not ghostwriter)**: The coach never produces text a student would hand in, never gives the final answer to graded work, and never does an annotation the assignment asked the student to do — enforced server-side for every student code; developer mode exists only for Ben and is never distributed.
- **Tech stack**: Chrome extension (Manifest V3-style side panel) + Python stdlib coach server with a mock engine for tests; `npm test` runs four suites before every friends build.
- **Distribution**: Pilot distributes via unpacked zip (`npm run package:friends`); Chrome Web Store listing is a later concern.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Coach replies capped at ~120 words / 6 lines by default | Matches student attention span and the daily token budget per student | ✓ Good — live v0.8.21 |
| Coach only speaks when spoken to (extras off by default) | Avoid nagging; the one exception is the clock's own time-up control | ✓ Good — live v0.8.19 |
| Overdue counts for 5 days after due date, then goes stale until the teacher marks it MISSING | Blackbaud calls anything past-due-and-unticked OVERDUE forever, even when it's actually done | ✓ Good — live v0.8.20 |
| Whole school year is read, finished work folded (not hidden) at the bottom | Nothing the student can see in the portal should be invisible in the app | ✓ Good — live v0.8.19 |
| Per-assignment annotation rule: no annotate/summarize help when the annotation itself is the graded work | Keeps the tutor-not-ghostwriter rule intact for reading assignments | ✓ Good — built v0.8.17 for 📸/📷; text highlighter still needs it |
| "Legal everywhere, with schools too" cuts any non-compliant feature outright | Protects pilot students from school action; non-negotiable per Ben | — Pending (governs all future scope decisions) |
| Milestone reprioritized around "get pilot friends testing," Blackbaud-only for now | Ben's stated near-term goal; Canvas/Classroom/Aeries and Phase 3 UX polish (cadence, one-bubble coach, finish moment) don't block a first pilot wave | — Pending (decided 2026-09-17) |
| Google OAuth fix (manifest `key` + re-pointing both OAuth clients) moved up to blocking priority | Confirmed during Phase 1 planning that neither OAuth door works for a friend's own install today — every friend gets a different Chrome extension ID, which neither registered OAuth client recognizes | — Pending (decided 2026-09-17, in progress) |
| Coach server hosts on Fly.io with a real Anthropic API key and per-friend access codes | User selected Fly.io for now on 2026-09-24, superseding the September 17 Mac mini + Cloudflare Tunnel decision; reuse existing `deploy/` scaffolding | — Pending implementation |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-24 after switching pilot coach hosting to Fly.io; remaining scope unchanged*
