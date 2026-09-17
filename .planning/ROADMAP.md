# Roadmap: Focus Agent

## Overview

Focus Agent is a working v0.8.21 Chrome extension, validated end-to-end on one user (Blackbaud/myPoly). This milestone closes the 18 named "Active" gaps in PROJECT.md so it can survive contact with 4-5 real friends across Blackbaud, Canvas, Google Classroom, and Aeries schools. The path: unblock everything Google-dependent with a stable extension ID and hardened OAuth, extend the already-proven adapter contract to Canvas grades/schedule and Google Classroom, extend the already-tested clock state machine with enforced cadence plus a one-bubble coach plus a real finish moment, reverse-engineer and fixture-test a fourth adapter (Aeries), and finally get the coach server off Ben's laptop with a real API key and a full real-device verification pass. No new frameworks, no new product surfaces beyond what's already named in the spec — this is closing gaps in a system that already works, in dependency order.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Stable Extension ID + OAuth Hardening** - A pilot friend on a school-managed Chrome account can sign in with Google reliably, and that access keeps working across reloads and over time
- [ ] **Phase 2: Canvas + Google Classroom Read Access** - Canvas and Google Classroom students see the same grades/schedule picture Blackbaud students already get
- [ ] **Phase 3: Enforced Cadence + One-Bubble Coach + Finish Moment** - Work sessions have an unskippable work/break rhythm, one clear coach suggestion at a time, an honestly-built checklist, and a true finish moment
- [ ] **Phase 4: Aeries Adapter + Fixture Tests** - An Aeries student gets full portal support, and every adapter is protected by a fixture test that catches shape-drift before it ships
- [ ] **Phase 5: Hosted Coach Server + Real-Device QA** - The coach server runs for real friends off Ben's laptop, its daily-cap behavior is a deliberate decision, and the whole extension has been run for real and checked for basic accessibility

## Phase Details

### Phase 1: Stable Extension ID + OAuth Hardening
**Goal**: A pilot friend on a school-managed Chrome account can complete Google sign-in, and that connection keeps working across reinstalls, reloads, and time.
**Mode:** mvp
**Depends on**: Nothing (first phase; blocks every other Google-dependent phase)
**Requirements**: AUTH-01, AUTH-02, AUTH-03
**Success Criteria** (what must be TRUE):
  1. The extension loads with the same stable ID across reinstalls and unpacked reloads (manifest `key`), so registered Google OAuth redirect URIs never break.
  2. A student on a school-managed account that blocks third-party OAuth apps can still connect via the personal-Gmail fallback door.
  3. When a pilot friend's Google authorization lapses (Testing-mode 7-day expiry), the extension surfaces a clear "reconnect Google" prompt instead of a silent or raw error.
**Plans**: TBD

Plans:
- [ ] 01-01: TBD

### Phase 2: Canvas + Google Classroom Read Access
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

### Phase 3: Enforced Cadence + One-Bubble Coach + Finish Moment
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

### Phase 4: Aeries Adapter + Fixture Tests
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

### Phase 5: Hosted Coach Server + Real-Device QA
**Goal**: The coach server runs reliably for real friends off Ben's laptop, its daily-cap behavior under restarts is a deliberate decision, and the extension's core behaviors and basic accessibility have been verified for real before any store listing.
**Mode:** mvp
**Depends on**: Phases 1-4 (gated last so the real-device pass and hosted server cover every new surface added earlier in the milestone)
**Requirements**: INFRA-01, INFRA-02, QA-01, QA-02
**Success Criteria** (what must be TRUE):
  1. The coach server is reachable by pilot friends from a real hosted deployment, off Ben's own Mac, using a real API key.
  2. The per-code daily call cap either survives the host's normal restart/scale-to-zero behavior, or that reset behavior is an explicit, documented, accepted decision rather than an accident.
  3. Each core real-extension behavior (chime, 45s stop, mid-sitting reload, screenshot/photo capture, a real scanned PDF, a real YouTube tab with captions and frames, the missing/overdue section on a live feed, attached links opening, fresh-profile install, Google sign-in on a second machine) has been run for real at least once.
  4. The extension has basic accessibility coverage — labels, focus rings, live regions — verified before any store listing.
**Plans**: TBD

Plans:
- [ ] 05-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Stable Extension ID + OAuth Hardening | 0/TBD | Not started | - |
| 2. Canvas + Google Classroom Read Access | 0/TBD | Not started | - |
| 3. Enforced Cadence + One-Bubble Coach + Finish Moment | 0/TBD | Not started | - |
| 4. Aeries Adapter + Fixture Tests | 0/TBD | Not started | - |
| 5. Hosted Coach Server + Real-Device QA | 0/TBD | Not started | - |
