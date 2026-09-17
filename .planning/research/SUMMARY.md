# Project Research Summary

**Project:** Focus Agent
**Domain:** Chrome MV3 side-panel extension (student-portal reader + focus clock + boundary-enforced AI tutor) + a small Python coach server — expanding from a 1-person pilot to a 4-5-friend pilot across Blackbaud, Canvas, Google Classroom, and Aeries
**Researched:** 2026-09-17
**Confidence:** MEDIUM-HIGH

## Executive Summary

Focus Agent is not a greenfield build — it's a working v0.8.21 product (validated on Blackbaud/myPoly, one user) moving into a friends-pilot milestone with three concrete additions: (1) closing known gaps in Google OAuth stability and adding Canvas grades/schedule + Google Classroom read access, (2) an enforced work/break cadence plus a one-bubble coach UI plus refined distraction negotiation plus a finish/streak moment, and (3) hosting the coach server off the founder's laptop. All four research passes agree on the same meta-finding: the underlying architecture and deployment groundwork already exist and are sound — the work is closing specific, already-named gaps, not designing new systems. The adapter contract (adapters/schema.js + capability-checked lib/snapshot.js), the focus-clock alarm state machine (CHECKIN_ALARM/DETECT_ALARM), the two-door Google OAuth pattern (getAuthToken + launchWebAuthFlow), and the deployment artifacts (deploy/Dockerfile, deploy/fly.toml) are all already built correctly per current best practice — extend them, don't rebuild them.

The recommended approach: fix the extension-ID instability first (a one-time manifest key + OAuth client update — this blocks everything else Google-related and is the single highest-leverage unblock), then layer in Canvas/Classroom read access reusing the identical OAuth plumbing, then add cadence as new session-record state inside the existing clock alarm system (never repurposing the hard-stop alarm), then ship the already-written deployment config to Fly.io. The one-bubble coach, cadence, and finish-moment features are UI/composition wins over data Focus Agent already has — genuinely low technical risk. The main product-level open question (negotiate vs. block for distractions) is explicitly gated on a decision Ben hasn't made with his dad yet, and research is unanimous that no roadmap phase should build blocking-tier code ahead of that conversation.

The dominant risk category across all four files isn't "will it work" — it's trust and silent failure at pilot scale. Reverse-engineered portal adapters can silently misread status codes (this already happened once, v0.8.17); a portal ToS breach or a parent/IT department noticing "unusual" extension traffic could end a friend's pilot participation or worse; the tutor boundary's weak point isn't the tested mode-switch mechanisms but the un-tested classification judgment ("is this graded?") and prompt injection via ingested file/doc content; and Google OAuth on school-managed Workspace accounts fails in three compounding, non-obvious ways that all look like "it's broken," not "needs a fix," to a first-time friend. Every mitigation is cheap relative to the risk (fixture tests, a stable manifest key, a one-page "if a school asks" note, closing the known summarize leak) and should be treated as pre-onboarding gates per portal/per friend, not nice-to-haves.

## Key Findings

### Recommended Stack

No new frameworks or languages are introduced by this milestone — the stack question was really "how do we close three specific integration gaps" in the existing Chrome MV3 extension + Python stdlib coach server. lib/google.js's existing two-door OAuth pattern (chrome.identity.getAuthToken for the common case, chrome.identity.launchWebAuthFlow against a Web-application OAuth client as the school-managed-account fallback) is exactly Chrome's current documented approach and should be kept as-is. The one missing piece is a stable extension ID via manifest key (RSA keypair, public key in manifest, private key kept out of git) — without it, every fresh "load unpacked" breaks both OAuth doors. Canvas grades/schedule need no new auth at all (same cookie-session fetch pattern already used for Blackbaud); Google Classroom reuses the same OAuth scopes list but needs the Classroom API enabled and narrow, student-facing (.me.) scopes, never the teacher/admin variants. For hosting, deploy/fly.toml's existing scale-to-zero Fly Machines config matches 2025/2026 best practice for this exact workload (bursty, homework-hours traffic, 5-10 users) and should be deployed as-is; bridge/coach_server.py (pure Python stdlib, not Node) should not be rewritten into a framework.

**Core technologies:**
- chrome.identity (getAuthToken + launchWebAuthFlow) — Google OAuth, two-door pattern already implemented correctly, just needs a stable extension ID
- Manifest key field (RSA keypair) — the standard, only mechanism for a deterministic unpacked extension ID across machines
- Fly.io Machines (scale-to-zero, already configured in deploy/fly.toml) — cheapest, lowest-ops always-on host for a tiny bursty Python HTTP server; HTTPS automatic
- Canvas/Classroom REST APIs (existing session cookie for Canvas; OAuth .me. scopes for Classroom) — no new architecture, just new endpoints/scopes on existing plumbing

### Expected Features

The four planned features (enforced cadence, one-bubble coach, negotiate-vs-block refinement, finish/streak moment) sit in a mature competitive category (Forest, Opal, Cold Turkey/Freedom for focus/blocking; no direct competitor combines a focus clock + AI tutor + portal context). Research is confident Focus Agent's differentiator is combining assignment-aware context with structural (not just emotional) enforcement, in a way no competitor does.

**Must have (table stakes):**
- A break that's timer-enforced (not just suggested) with visible countdown and auto-resume to work — extends the already-validated hard-planned-end clock state machine
- A single next-suggestion surface (one bubble) instead of a chip menu — matches current chat-UI consensus
- Distraction handling that gives some signal, never silent — already validated, refinement only
- Some end-of-session acknowledgment beyond "clock stopped" — bar is low: one true, specific line clears it

**Should have (competitive):**
- Break cadence keyed to actual assignment/checklist state, not a blind timer (re-anchor to "back to Q3-5" at break-end)
- Difficulty-tiered break enforcement (soft/firm/hard, Opal-style) — v1.x, after single-tier is tester-validated
- Negotiation that cites specifics from the assignment, not generic "stay focused"
- A finish line that names the actual work done ("Finished the lab report, 3 sittings") — cheapest of the four, ship first as a quick validated win

**Defer (v2+):**
- Any blocking (vs. negotiating) tier for distracting sites — explicitly blocked on Ben's undecided product conversation with his dad
- Streak/momentum mechanics — only in gentle, non-shaming form, and only after the non-streak finish moment is tester-validated
- Any analytics/reporting surface shared with parents/schools, or hard OS-level blocking, or AI-detection-evasion features — all explicitly anti-features that conflict with the product's legal/privacy/tutor-not-ghostwriter constraints

### Architecture Approach

This is an integration-boundary problem, not a system design problem: all three additions plug into existing, proven boundaries. The Adapter Contract (adapters/schema.js normalizes everything into one Assignment shape; lib/priority.js/lib/snapshot.js are portal-blind) already supports adding Aeries as a fourth adapter with zero downstream changes. The clock alarm system (CHECKIN_ALARM = hard stop, DETECT_ALARM = idle watchdog) must never be repurposed — cadence needs a new, independent CADENCE_ALARM added to session-record state, following the exact same arm/clear/rearm pattern already tested by test-background.js's 14 cases. The coach-server hosting change is almost entirely operational (deploy already-written deploy/ artifacts) except for one real architectural decision: the in-memory daily call cap resets on every process restart, and Fly's scale-to-zero means restarts happen far more often than on Ben's always-on Mac — this needs an explicit decision (accept weaker cap / always-on Fly / persist cap to disk), not a silent default.

**Major components:**
1. adapters/*.js + adapters/schema.js/detect.js — portal-specific read logic, normalized to one Assignment shape; Aeries is a new peer, not a new pattern
2. background.js service worker — alarm-driven session state machine; cadence is new state on the same session record, a new independent alarm, never a repurposed one
3. bridge/coach_server.py + deploy/* — stdlib Python HTTP server with server-side tutor-mode enforcement; deployment config already written, ship as-is except for the daily-cap persistence decision

### Critical Pitfalls

1. Silent portal-adapter drift (already happened once, v0.8.17 OVERDUE bug) — reverse-engineered endpoints can silently return wrong/stale data with a confident-looking clean UI. Prevention: build fixture tests per portal before that portal's first real friend, add a "shape doesn't match — verify in portal" fail-loud banner instead of defaulting to empty.
2. Portal ToS breach becomes "reason for a school to act against a student" — undocumented endpoint access looks identical to an anomaly-detection dashboard as any other automated traffic. Prevention: keep reads strictly tap-triggered (never background polling), read each new portal's ToS before shipping that adapter to a real friend, never add credential-sharing/session-import conveniences.
3. "We don't store PII server-side" is not "a school will trust this" — institutional/parent trust is evaluated on optics of unauthorized access, not privacy architecture; one parent or IT department asking "what is this reading" can end a friend's pilot participation. Prevention: friend (never Ben, never IT) installs/connects; keep "your own login, your own browser" framing disciplined; have a one-page "if a school asks" note ready per friend.
4. The tutor boundary leaks through un-tested classification judgment and prompt injection, not through dramatic jailbreaks — the known, already-named gap is the text-highlighter's summarize action being unconditional (not yet wired to the annotation rule that screenshot/photo annotate already obey); the untested surface is adversarial file/doc content and multi-turn erosion. Prevention: close the summarize gap immediately; build an adversarial fixture set run against the real model before the hosted server goes live with a real API key.
5. Google OAuth on school-managed accounts fails in three compounding, non-obvious ways — unstable extension ID breaks the OAuth redirect outright; Workspace admin policy commonly blocks third-party apps with no useful error; broad scope choices can accidentally tip into Google's expensive CASA-required tier. Prevention: pin the manifest key now (hard blocker before any Google-dependent friend), test the personal-Gmail fallback on a real second/school-managed machine, keep Drive scope at drive.file permanently.

## Implications for Roadmap

Based on combined research, suggested phase structure for this milestone:

### Phase 1: Stable extension ID + OAuth hardening
**Rationale:** Every other Google-dependent feature (Classroom, Docs, existing Google connect) is blocked by extension-ID instability; this is a one-time fix with no dependencies and the highest leverage per research (named as the top Active item in PROJECT.md, and STACK.md/PITFALLS.md/ARCHITECTURE.md all independently flag it as the first blocker to clear).
**Delivers:** Manifest key generated and committed pattern, both OAuth clients (Chrome-Extension-type and Web-application-type) updated to the stable ID, personal-Gmail fallback door tested end-to-end on a real second/school-managed machine, Testing-mode 7-day re-auth failure surfaced as a clear "reconnect Google" UX rather than a raw error.
**Addresses:** Foundation for FEATURES.md's Google-dependent work; not itself a user-facing feature.
**Avoids:** Pitfall 5 (three compounding OAuth failure modes) and the redirect-URI instability named in PITFALLS.md.

### Phase 2: Canvas grades/schedule + Google Classroom read access
**Rationale:** Architecturally decoupled from cadence/UI work; depends only on Phase 1's stable OAuth foundation for the Classroom half (Canvas grades need no new auth at all and could start immediately in parallel).
**Delivers:** Canvas enrollments endpoint (include current_period_scores) for grades; Canvas schedule scoped down to due-dates (not a bell schedule, which Canvas generally doesn't model); Classroom API enabled with narrow .me. scopes (courses, coursework, courseworkmaterials); per-school admin allow-listing tracked as a relationship/coordination task with lead time, separate from the code.
**Uses:** Existing credentialed-fetch pattern for Canvas; existing OAuth scopes list (extended) for Classroom.
**Implements:** No new architecture component — reuses the Adapter Contract and the two-door OAuth pattern from Phase 1.

### Phase 3: Enforced cadence + one-bubble coach + finish moment
**Rationale:** FEATURES.md explicitly ranks these P1, low-medium cost, and notes the one-bubble coach is the natural delivery surface the other two want — building it first lets it absorb break-transition and finish-moment messaging cheaply rather than retrofitting two bespoke UI moments later. Fully decoupled from Phases 1-2 (different files: background.js alarm logic + sidepanel/panel.js, vs. adapters/* + OAuth).
**Delivers:** session.cadence state + new independent CADENCE_ALARM (never repurposing CHECKIN_ALARM), panel-side break UI with disabled skip controls, idle/distraction-watcher phase guards, one-bubble UI replacing the chip row, and a specific-data finish-moment debrief line (no streak yet).
**Addresses:** FEATURES.md's three P1 items (enforced cadence, one-bubble coach, finish moment).
**Avoids:** The anti-pattern of repurposing CHECKIN_ALARM for cadence — collapses two different tested guarantees into one alarm.

### Phase 4: Aeries adapter (portal #4)
**Rationale:** Fully parallelizable per ARCHITECTURE.md; sequenced later here mainly because it's net-new integration work (DevTools reverse-engineering) versus the other phases' extension-of-existing-pattern work, and should build its fixture test before, not after, the first real Aeries friend.
**Delivers:** adapters/aeries.js following the existing Adapter Contract, manifest/background/detect.js wiring, a fixture test built from a captured DevTools session, single-district validation caveat documented (Aeries is multi-tenant; don't assume portability across districts).
**Addresses:** Portal coverage for whichever friend uses Aeries.
**Avoids:** Silent adapter drift via fixture-first build order; the integration gotcha of assuming one district's adapter generalizes.

### Phase 5: Hosted coach server + tutor-boundary hardening
**Rationale:** Fully decoupled operationally but sequenced last here because it's the natural gate before handing real API-backed access to friends across all the new content/portal surfaces built in Phases 2-4 — the adversarial prompt-injection/classification test pass is most valuable once new content channels (Classroom materials, Canvas grades context) exist to test against.
**Delivers:** Real ANTHROPIC_API_KEY provisioned, fly deploy of the existing (unmodified) deploy/ artifacts, daily-cap in-memory-vs-persisted decision made explicitly (not defaulted), cold-start/timeout smoke tests against the real deployed URL, the known summarize annotation-rule gap closed, and an adversarial fixture set (hidden-instruction content, ambiguous-instruction assignment, multi-turn erosion) run against the real model before any friend's first real multi-turn session.
**Addresses:** PROJECT.md's Active item "Hosted coach server deployed off Ben's Mac with a real API key."
**Avoids:** Tutor-boundary leaks via classification (not jailbreaks) and the daily-cap-reset performance trap.

### Phase Ordering Rationale

- Phase 1 must come first because it's a hard, named blocker for every other Google-touching phase (Phase 2's Classroom half) and is cheap/fast to fix — clearing it early de-risks the rest of the milestone.
- Phases 2, 3, and 4 have no cross-dependencies per ARCHITECTURE.md's explicit build-order table and could in principle run in parallel across different sessions/people; the ordering above (Canvas/Classroom, then cadence/UI, then Aeries) reflects FEATURES.md's priority ranking and PITFALLS.md's "each new portal is a go/no-go gate" framing, not a technical dependency — a team could reorder 2-4 freely.
- Phase 5 is placed last deliberately even though it's technically decoupled, because it's the point at which real friends get real, unthrottled access to everything built in the earlier phases — gating it last maximizes how much surface area (new content channels, new portals) the adversarial security pass can cover before it matters.
- This order also naturally sequences the two "must never build ahead of a decision" items correctly: no phase above schedules blocking-tier distraction handling (blocked on Ben's conversation with his dad) or any broadened-scope/analytics anti-feature.

### Research Flags

Needs deeper research during planning:
- Phase 2 (Classroom): MEDIUM confidence on the exact under-18 blocking UX interaction and per-school admin allow-listing turnaround; verify with the first real Classroom friend rather than assuming.
- Phase 4 (Aeries): No existing DevTools session or fixture yet; genuinely under-documented (no public API docs, multi-tenant district variation). This is the one phase where research during planning (a live reconnaissance session) is load-bearing, not optional.
- Phase 5 (coach server hardening): The prompt-injection/classification adversarial test design is a real open design question, not just an implementation task — worth a dedicated discussion pass before planning the phase in detail.

Phases with standard, well-documented patterns (skip research-phase):
- Phase 1: Manifest key mechanism and two-door OAuth pattern are both officially documented and already correctly scoped in STACK.md; execution is mechanical.
- Phase 3: Cadence state machine extends an already-tested pattern (test-background.js) with a clear, fully-specified recommended component boundary already in ARCHITECTURE.md.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH on OAuth/manifest-key/Fly.io mechanics (official docs, cross-checked); MEDIUM on exact Canvas endpoint shapes and precise Google verification turnaround (never run against a real account yet) |
| Features | MEDIUM | No official research-tool seam available in the research environment; based on web search of vendor pages, app-review blogs, and UX-pattern aggregators rather than a cached-provider pipeline — directionally solid but not authoritative-source-verified |
| Architecture | HIGH | Grounded entirely in the current codebase with file:line citations, not external sources — this is an integration-boundary analysis of code that already exists and runs, not speculation |
| Pitfalls | MEDIUM-HIGH | Chrome Web Store/OAuth verification claims are HIGH (Google's own docs); scraping-ToS and FERPA claims are MEDIUM (well-established general pattern, no portal-specific incident found for Blackbaud/Canvas/Aeries); AI-tutor-leak claims are MEDIUM (well-documented in broader LLM-guardrail literature, no incident specific to this product's boundary design) |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- Canvas grades/schedule exact param names and response shapes: verify against a real Canvas account on first implementation, treat STACK.md's endpoint list as "verify on first real test," not gospel.
- Under-18 Google Workspace account blocking UX and per-school admin allow-listing lead time: only resolvable empirically with the first real Classroom friend's school; budget lead time (a day ahead of test) for admin console indexing.
- Aeries adapter portability across districts: Aeries is multi-tenant with district-level customization; the first adapter is provisional until validated against a second Aeries district, if one is ever onboarded.
- Fly.io cold-start latency for coach_server.py specifically (vs. generic ~1s VM-wake docs) and whether Fly's edge imposes any hidden request-length cap relevant to the 150s claude-cli-fallback path: both need a real deployed-URL smoke test, not just docs.
- The daily-call-cap in-memory-vs-persisted decision (Phase 5) is explicitly unresolved and should be made deliberately during planning, not defaulted to "accept" by inertia.
- The negotiate-vs-block distraction-handling product decision remains open pending a conversation between Ben and his dad — no phase in this roadmap should build blocking-tier code ahead of that resolution.

## Sources

### Primary (HIGH confidence)
- chrome.identity API reference (developer.chrome.com) — OAuth door split, getRedirectURL() behavior
- Manifest key field reference (developer.chrome.com) — stable extension ID mechanism
- Google Classroom API — Choose scopes (developers.google.com) — .me. vs teacher-facing scope distinction
- Restricted scope verification (developers.google.com) — 100-user CASA threshold
- Manage App Audience / Internal-External-Testing (support.google.com) — Testing-mode 7-day expiry, Internal/Workspace-org requirement
- Control which apps access Google Workspace data (support.google.com) — App access control / Trusted-app-by-client-ID flow
- Fly.io pricing (fly.io/docs) — Machines model, free Hobby tier deprecation
- hiQ Labs, Inc. v. LinkedIn Corp. — Ninth Circuit opinion analysis — scraping legal precedent, contract/trespass exposure
- PowerSchool Terms of Use — vendor scraping-prohibition ToS pattern
- Google Sensitive/Restricted scope verification docs — scope tier classification
- Full current codebase (adapters/, background.js, bridge/coach_server.py, deploy/, docs/SPEC.md, .planning/PROJECT.md) — primary source for ARCHITECTURE.md, grounding every finding in file:line citations

### Secondary (MEDIUM confidence)
- Canvas LMS REST API — Enrollments/Calendar Events docs — endpoint shapes, summarized via search not directly fetched
- Google Workspace admin help on unconfigured third-party apps / under-18 accounts — aggregated via search, not single fetched primary page
- Forest/Opal/Cold Turkey/Freedom product pages and reviews — competitor feature landscape
- CrackedPDFs hidden prompt injection benchmark — prompt-injection-via-document pattern
- FERPA "school official" exception — EFF/Dept of Education — institutional trust framework

### Tertiary (LOW confidence)
- Render/Railway free-tier and cold-start comparisons — third-party 2026 comparison sites, directionally consistent but not primary
- App-review blogs (Opal, Session reviews) — used for feature-landscape context, not load-bearing technical claims

---
*Research completed: 2026-09-17*
*Ready for roadmap: yes*
