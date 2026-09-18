---
gsd_state_version: "1.0"
milestone: v0.8.21
current_phase: 1
current_phase_name: Stable Extension ID + OAuth Hardening
status: planning
stopped_at: Session paused mid-plan-phase-1 to reprioritize around pilot-readiness; roadmap/requirements updated, no code changed yet
last_updated: "2026-09-17T23:42:59.026Z"
last_activity: 2026-09-17
last_activity_desc: "Reprioritized milestone around pilot-readiness (Blackbaud-only): inserted Phase 1.5, moved Phases 2-5 to deferred, trimmed v1 requirements to AUTH-01/02/03 + INFRA-01/02 + PILOT-01"
state_head: 0706acb0ca9d6d2c28c1358342d9290274009f8b
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-17)

**Core value:** One tap (Smart Start) gets a student from "can't start" to "working, with structure they can't talk their way out of, and a tutor beside them that never ghostwrites."
**Current focus:** Phase 1 — Stable Extension ID + OAuth Hardening, then Phase 1.5 — Mac Mini Coach Hosting + Pilot Smoke Test. (Phases 2-5 are deferred until after the first pilot wave — see ROADMAP.md Overview.)

## Current Position

Phase: 1 of 6 (Stable Extension ID + OAuth Hardening) — has CONTEXT.md, no PLAN.md yet
Next up after Phase 1: Phase 1.5 (Mac Mini Coach Hosting + Pilot Smoke Test) — roadmapped, not yet discussed/planned
Plan: 0 of TBD in current phase
Status: Ready to plan (see "Resuming this project" below before running plan-phase)
Last activity: 2026-09-17 — Reprioritized around pilot-readiness after a mid-session pause

Progress: [░░░░░░░░░░] 0%

## Resuming This Project (you're new to GSD — read this first)

This project uses **GSD** (a structured planning/build workflow: discuss → plan → execute → verify, per phase). You paused mid-flow, so here's how to pick it back up correctly instead of guessing at slash commands:

1. **Start with `/gsd-progress`** (or just `/gsd-next`) — either one reads this file plus ROADMAP.md and tells you exactly where things stand and what command to run next. Don't manually re-run `/gsd-new-project` — the project already exists.
2. **The next real step is `/gsd-plan-phase 1`** — Phase 1 (OAuth) already has its context captured (`.planning/phases/01-stable-extension-id-oauth-hardening/01-CONTEXT.md`); this turns that into an actual task plan. Add `--auto` only if you want it to run unattended through research → plan → verify without stopping for your input.
3. **After Phase 1 ships, do `/gsd-discuss-phase 1.5`** to capture context for the Mac Mini + Cloudflare Tunnel phase (its ROADMAP.md entry has the architecture already decided, but discuss-phase will ask a few implementation questions before planning), then `/gsd-plan-phase 1.5`.
4. **Stay pilot-focused.** Phases 2 (Canvas/Classroom), 3 (cadence/coach UI), 4 (Aeries), and 5 (full QA/accessibility) are real and still in ROADMAP.md, but they're marked ⏸ DEFERRED on purpose. Don't let a GSD auto-advance chain (`--auto`/`--chain`) run past Phase 1.5 into Phase 2 without deciding that's actually what you want next — check in on priority before continuing past the pilot-critical work.
5. If you're ever unsure what to run, `/gsd-help` lists commands, and `/gsd-progress` is always safe to run as a status check — it doesn't change anything.

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: - min
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- **2026-09-17 reprioritization:** milestone goal narrowed to "get pilot friends actually testing it," Blackbaud-only. Phase 1.5 inserted (Mac Mini + Cloudflare Tunnel + real API key + a live core-loop smoke test); Phases 2, 3, 4, 5 marked deferred (not cancelled) in ROADMAP.md. REQUIREMENTS.md v1 trimmed to AUTH-01/02/03 + INFRA-01/02 + PILOT-01; the rest moved to v2 with their original phase assignment preserved for later.
- **2026-09-17:** confirmed (not hypothetical) that Google OAuth is broken for any friend's own install today — Chrome assigns a different extension ID per install path, and both registered OAuth clients (Chrome-Extension type + Web-application type) are pinned to Ben's current dev ID. This is why AUTH-02 (manifest `key`) is now pilot-blocking, not just roadmapped.
- **2026-09-17:** coach server hosting decided as Mac mini + Cloudflare Tunnel + real Anthropic API key, not the existing Fly.io `deploy/` scaffolding. `bridge/coach_server.py` already supports this natively (`FA_HOST=0.0.0.0`, `ANTHROPIC_API_KEY`/`~/.focus-agent/api_key`, `FA_TOKENS`/minted per-friend codes) — no new code needed, just configuration + the tunnel setup.
- **2026-09-17:** two bugs found by code review during Phase 1 planning, deferred (not fixed) per Ben's choice — see PROJECT.md Context "Known issues": (1) 📸 button text-overflow when no assignment is open, (2) 🖍 highlighter's ≡ summarize ignores the graded-annotation rule (this is COACH-02).
- Roadmap (original, still governs Phases 2-5 order when resumed): OAuth stability first (blocks all other Google-dependent work), then Canvas/Classroom read access, then cadence/coach/finish-moment UI (decoupled, sequenced by priority), then Aeries adapter (depends on Phase 2's adapters existing for fixture coverage), then the rest of real-device QA (gated last).
- Roadmap: No phase schedules blocking-tier distraction handling (ENGAGE-01) — explicitly gated on Ben's undecided conversation with his dad, deferred to v2 per REQUIREMENTS.md.

### Pending Todos

- Mint a Cloudflare Tunnel + confirm the Mac mini can stay reachable (Phase 1.5, not yet planned).
- Get the real Anthropic API key into `~/.focus-agent/api_key` on the Mac mini when ready (Phase 1.5).
- Decide the daily-call-cap-across-restart policy for the Mac mini before Phase 1.5 ships (INFRA-02) — this was explicitly left open, don't default it by inertia.

### Blockers/Concerns

- Phase 1 (OAuth) is the current blocker for anything Google-dependent, including parts of Phase 1.5 if friends need Google-connected features during the smoke test (PILOT-01 itself doesn't require Google, so it can proceed in parallel/after).
- Phase 2 (Classroom, deferred): under-18 blocking UX and per-school admin allow-listing turnaround is unverified — budget lead time before the first real Classroom friend test, when that wave resumes (research flag, MEDIUM confidence).
- Phase 4 (Aeries, deferred): no existing DevTools session or fixture yet; genuinely under-documented (no public API docs, multi-tenant district variation) — treat as a live reconnaissance task during planning, not a known quantity, when that wave resumes.
- Phase 1.5 (coach server hardening): the daily-call-cap in-memory-vs-persisted decision is explicitly unresolved and must be made deliberately during planning, not defaulted by inertia.
- Unconfirmed bug (needs live testing, not yet reproduced): the crayon toolbar may not auto-appear on the very first visit to a newly-permitted site opened by Smart Start — see PROJECT.md Context "Known issues," BUG-03 in REQUIREMENTS.md.

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-09-17T23:42:59.020Z
Stopped at: Reprioritized around pilot-readiness (see "Resuming This Project" above); Phase 1 still has only CONTEXT.md, no PLAN.md — nothing was executed/coded this session
Resume file: .planning/phases/01-stable-extension-id-oauth-hardening/01-CONTEXT.md
Next command: /gsd-progress (to confirm state), then /gsd-plan-phase 1
