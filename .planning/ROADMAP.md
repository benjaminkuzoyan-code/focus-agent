# Roadmap: Focus Agent

## Overview

Focus Agent is a working v0.8.21 Chrome extension, validated end-to-end on one user (Blackbaud/myPoly). The original milestone plan closed 18 "Active" gaps in PROJECT.md across Blackbaud, Canvas, Google Classroom, and Aeries. **Reprioritized 2026-09-17**: the immediate goal is narrower — get pilot friends actually testing the app, Blackbaud-only. That means Phase 1 (OAuth) and a new Phase 1.5 (Fly.io coach hosting + a live smoke test) are the active work; Phases 2-5 below are real, still-roadmapped work put on hold until after the first pilot wave, not cancelled. See `.planning/PROJECT.md` Key Decisions and `.planning/REQUIREMENTS.md` for the full reasoning and the v1→v2 requirement moves.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order. Phase 1.5 below is an insertion driven by the 2026-09-17 reprioritization, not an emergency fix — the INSERTED convention still applies to keep the numbering scheme consistent.

- [ ] **Phase 1: Stable Extension ID + OAuth Hardening** - 🎯 ACTIVE - A pilot friend on a school-managed Chrome account can sign in with Google reliably, and that access keeps working across reloads and over time
- [ ] **Phase 1.5: Fly.io Coach Hosting + Pilot Smoke Test** - 🎯 ACTIVE - INSERTED 2026-09-17; hosting revised 2026-09-24 - The coach server runs on Fly.io, and the core Blackbaud pilot loop has been verified live with a real friend account
- [ ] **Phase 2: Canvas + Google Classroom Read Access** - ⏸ DEFERRED until after first pilot wave - Canvas and Google Classroom students see the same grades/schedule picture Blackbaud students already get
- [ ] **Phase 3: Enforced Cadence + One-Bubble Coach + Finish Moment** - ⏸ DEFERRED until after first pilot wave - Work sessions have an unskippable work/break rhythm, one clear coach suggestion at a time, an honestly-built checklist, and a true finish moment
- [ ] **Phase 4: Aeries Adapter + Fixture Tests** - ⏸ DEFERRED until after first pilot wave - An Aeries student gets full portal support, and every adapter is protected by a fixture test that catches shape-drift before it ships
- [ ] **Phase 5: Full Real-Device QA + Accessibility** - ⏸ DEFERRED until after first pilot wave - The hosted-server piece of the original Phase 5 moved to Phase 1.5; what's left here is the rest of the real-device pass and accessibility, checked before any store listing

## Phase Details

### Phase 1: Stable Extension ID + OAuth Hardening

**Goal**: As a pilot friend on a school-managed Chrome account, I want to complete Google sign-in, so that my connection keeps working across reinstalls, reloads, and time.
**Mode:** mvp
**Depends on**: Nothing (first phase; blocks every other Google-dependent phase)
**Requirements**: AUTH-01, AUTH-02, AUTH-03
**Success Criteria** (what must be TRUE):

  1. The extension loads with the same stable ID across reinstalls and unpacked reloads (manifest `key`), so registered Google OAuth redirect URIs never break.
  2. A student on a school-managed account that blocks third-party OAuth apps can still connect via the personal-Gmail fallback door.
  3. When a pilot friend's Google authorization lapses (Testing-mode 7-day expiry), the extension surfaces a clear "reconnect Google" prompt instead of a silent or raw error.

**Plans**: 2/4 plans executed

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Stable-ID sign-in tracer and validated personal-account fallback

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Silent recovery, account continuity and reconnect chip
- [ ] 01-03-PLAN.md — Stable-key packaging and concrete owner runbook

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 01-04-PLAN.md — Final regression, both archives and real OAuth acceptance

### Phase 1.5: Fly.io Coach Hosting + Pilot Smoke Test

**INSERTED 2026-09-17** — reprioritization driven by "get pilot friends actually testing it," decided with Ben during Phase 1 planning.
**Goal**: The coach server runs on Fly.io with real model replies, and the core Blackbaud pilot loop has been verified live end to end with a real friend account.
**Mode:** mvp
**Depends on**: Phase 1 conceptually helps (friends need to be able to connect at all) but is not a hard technical dependency for this phase's own requirements — INFRA-01/02 and PILOT-01 don't touch OAuth. Sequenced right after Phase 1 because both are pilot-blocking.
**Requirements**: INFRA-01, INFRA-02, PILOT-01
**Architecture decided (2026-09-24):** Fly.io, using the existing `deploy/Dockerfile` and `deploy/fly.toml`, `FA_HOST=0.0.0.0`, a real `ANTHROPIC_API_KEY` stored as a Fly.io secret, HTTPS, and one access code per friend (`FA_TOKENS` / the `token` CLI helper). This supersedes the Mac mini + Cloudflare Tunnel approach. Always-on versus auto-stop and usage-cap persistence remain explicit Phase 1.5 planning decisions.
**Success Criteria** (what must be TRUE):

  1. `bridge/coach_server.py` is running on Fly.io with a real Anthropic API key configured as a secret (not the mock engine).
  2. The server is reachable over HTTPS from a pilot friend's machine, and refuses hosted startup without both the API key and at least one access code configured.
  3. Each pilot friend has their own minted access code with its own daily call cap.
  4. The per-code daily-cap behavior across restarts, deploys, and machine stop/start is documented and verified against the chosen persistence and always-on/auto-stop policy.
  5. A real friend account on Blackbaud completes the full core loop live: portal read → ranked list with the friend's real assignments → Smart Start → focus clock runs and enforces its planned-end behavior → coach chat gives a real (non-simple-mode) reply scoped to a real assignment.

**Plans**: TBD

Plans:

- [ ] 01.5-01: TBD

### Phase 2: Canvas + Google Classroom Read Access — ⏸ DEFERRED until after first pilot wave

**Goal**: Canvas and Google Classroom students see grades, schedule, and materials the way a Blackbaud student already does.
**Mode:** mvp
**Depends on**: Phase 1 (Classroom access needs the stable OAuth foundation; Canvas grades need no new auth and could start in parallel)
**Requirements**: PORTAL-01, PORTAL-02, PORTAL-03
**Success Criteria** (what must be TRUE):

  1. A Canvas student sees current grades displayed alongside their assignments.
  2. A Canvas student sees due dates/schedule information the way a Blackbaud student already does.
  3. A Google Classroom student, including an under-18 account on an allow-listed school, sees grades, materials, and schedule — not just the To-do assignment list.

**Plans**: TBD

Plans:

- [ ] 02-01: TBD

### Phase 3: Enforced Cadence + One-Bubble Coach + Finish Moment — ⏸ DEFERRED until after first pilot wave

**Goal**: A work session has a work/break rhythm the student can't talk their way out of, one clear next action from the coach at a time, a checklist that reflects real engagement, and a genuine finish moment.
**Mode:** mvp
**Depends on**: Nothing directly — technically decoupled from Phases 1-2 (different files: session/clock state and side-panel UI vs. adapters/OAuth); sequenced third per priority, not a technical dependency
**Requirements**: CLOCK-01, CLOCK-02, COACH-01, COACH-02, COACH-03, DONE-01
**Success Criteria** (what must be TRUE):

  1. A running work sitting automatically moves into a break when the work interval ends (the student can't skip or extend it), and work automatically resumes when the break ends without restarting the sitting.
  2. The coach panel UI shows one next-best-action bubble at a time in place of the standing row of chips.
  3. The text highlighter's summarize action is suppressed when annotating the passage is itself the graded work, matching the rule the screenshot/photo annotate tools already follow.
  4. The checklist is generated only after the student has opened resources and the instructions have actually been read, not from assignment-type rules alone.
  5. Finishing an assignment shows a specific, true one-line debrief describing what actually happened in that sitting, not a generic congratulations.

**Plans**: TBD
**UI hint**: yes

Plans:

- [ ] 03-01: TBD

### Phase 4: Aeries Adapter + Fixture Tests — ⏸ DEFERRED until after first pilot wave

**Goal**: An Aeries student gets full portal support, and every portal adapter is protected by a fixture test that would catch a silent shape/status-code drift before it ships.
**Mode:** mvp
**Depends on**: Phase 2 (fixture tests must cover the Canvas and Classroom adapters built there, in addition to the new Aeries adapter and the existing Blackbaud one)
**Requirements**: PORTAL-04, PORTAL-05
**Success Criteria** (what must be TRUE):

  1. An Aeries student can connect their portal and see assignments, grades, and schedule from inside their own logged-in session.
  2. Every portal adapter (Blackbaud, Canvas, Classroom, Aeries) has a fixture test, built from a captured real response, that fails loudly instead of silently misreading an unexpected shape or status code.
  3. The Aeries adapter is documented as validated against a single district only — not assumed to generalize across other Aeries districts.

**Plans**: TBD

Plans:

- [ ] 04-01: TBD

### Phase 5: Full Real-Device QA + Accessibility — ⏸ DEFERRED until after first pilot wave

**Goal**: Beyond Phase 1.5's core-loop smoke test, the rest of the extension's real-device behaviors and basic accessibility have been verified before any store listing.
**Mode:** mvp
**Depends on**: Phases 1-4 (gated last so the real-device pass covers every new surface added earlier in the milestone). Note: the hosted-coach-server requirements (INFRA-01, INFRA-02) that originally lived here moved to Phase 1.5 during the 2026-09-17 reprioritization — this phase now covers only QA-01-FULL and QA-02.
**Requirements**: QA-01-FULL, QA-02
**Success Criteria** (what must be TRUE):

  1. Each remaining real-extension behavior (chime, 45s stop, mid-sitting reload, screenshot/photo capture, a real scanned PDF, a real YouTube tab with captions and frames, attached links opening, fresh-profile install, Google sign-in on a second machine) has been run for real at least once.
  2. The extension has basic accessibility coverage — labels, focus rings, live regions — verified before any store listing.

**Plans**: TBD

Plans:

- [ ] 05-01: TBD

## Progress

**Execution Order (reprioritized 2026-09-17):**
Active now: 1 → 1.5. Everything after is deferred until after the first pilot wave, then resumes in order: 2 → 3 → 4 → 5.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Stable Extension ID + OAuth Hardening | 2/4 | In Progress|  |
| 1.5. Fly.io Coach Hosting + Pilot Smoke Test | 0/TBD | 🎯 Active (not yet planned) | - |
| 2. Canvas + Google Classroom Read Access | 0/TBD | ⏸ Deferred | - |
| 3. Enforced Cadence + One-Bubble Coach + Finish Moment | 0/TBD | ⏸ Deferred | - |
| 4. Aeries Adapter + Fixture Tests | 0/TBD | ⏸ Deferred | - |
| 5. Full Real-Device QA + Accessibility | 0/TBD | ⏸ Deferred | - |
