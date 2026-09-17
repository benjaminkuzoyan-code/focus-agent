# Architecture Research — Integrating Three Additions into Focus Agent v0.8.21

**Domain:** Chrome MV3 side-panel extension + small Node/Python coach server, for a subsequent milestone (not greenfield)
**Researched:** 2026-09-17
**Confidence:** HIGH — grounded entirely in the current codebase (file:line citations below), not external sources. This is an integration-boundary analysis of the existing architecture, not a survey of the domain.

This file does not re-describe the existing architecture in full (see `docs/SPEC.md` §1/§5/§19 and `.planning/PROJECT.md`). It answers one question per addition: **where does the new code plug in, what already-existing boundary does it reuse, and what must never move.**

---

## System Overview — where the three additions sit

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Portal tab (blackbaud.com / myschoolapp.com / instructure.com /          │
│  classroom.google.com / *** aeries — NEW ***)                             │
│                                                                             │
│  adapters/schema.js → adapters/detect.js → adapters/{blackbaud,canvas,    │
│  classroom, ***aeries-NEW***}.js → content.js (router) → lib/priority.js  │
│                                                                             │
│  ADDITION 1 plugs in HERE: a new adapters/aeries.js module only.           │
│  Nothing downstream (schema, priority, snapshot, panel) changes.           │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │ chrome.runtime.sendMessage (CACHE_ASSIGNMENTS,
                            │ GET_ASSIGNMENTS, GET_SNAPSHOT, GET_COACH_STATE)
                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  background.js — service worker (chrome.alarms)                           │
│                                                                             │
│  Existing: CHECKIN_ALARM (hard planned-end), DETECT_ALARM (idle watchdog, │
│  completion polling, 1×/min), COMMITMENT_ALARM, rearmActiveSession() on   │
│  onStartup/onInstalled.                                                   │
│                                                                             │
│  ADDITION 2 plugs in HERE: a new CADENCE_ALARM (or equivalent) alongside  │
│  the existing three, gated the same way (armed in SESSION_STARTED /       │
│  START_SESSION_FROM_PAGE, cleared in SESSION_ENDED / stopSession /        │
│  completeSession, re-armed in rearmActiveSession()). It must never        │
│  replace or repurpose CHECKIN_ALARM — that alarm IS the hard stop tested  │
│  by test-background.js and must keep meaning exactly "the planned end."   │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │ fetch() from lib/ai.js (ClaudeCoach), only on
                            │ a coach action, carrying X-FA-Token
                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  bridge/coach_server.py — today: 127.0.0.1:8000 on Ben's Mac              │
│                                                                             │
│  Handler.do_POST /coach → origin check → _who()/_role() → tutor-mode      │
│  normalize → BUILDERS[method] → _complete() (api|claude-cli|mock engine)  │
│                                                                             │
│  ADDITION 3 is NOT a new component — deploy/Dockerfile, deploy/fly.toml,  │
│  deploy/focus-agent-bridge.service, and deploy/README.md already exist    │
│  and run this exact same script unmodified. The extension side           │
│  (lib/ai.js FA.bridgeSig / initCoach, ⚙ → coach server field) already     │
│  supports a remote URL + access code. The only real work is an            │
│  operational decision (which host, always-on vs auto-stop) plus one       │
│  narrow code change if that decision requires it (see below).            │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Addition 1 — Aeries portal adapter

### The existing boundary (already proven by Canvas/Classroom, reuse it exactly)

The system already has a working **Adapter Contract** — Aeries is not a new pattern, it is the third/fourth implementation of one:

1. **`adapters/schema.js`** (`adapters/schema.js:58-78`) — `FA.makeAssignment({id, title, course, type, dueDate, points, url, source, raw})` is the only place that builds an Assignment. Every adapter calls it; nothing hand-rolls the shape. Aeries adapter must do the same.
2. **`adapters/detect.js`** (`adapters/detect.js:15,29-64`) — `SUPPORTED` set and `FA.detectPortal(host, doc)` decide which portal a page is, from hostname/markup only (isolated-world content script — no page JS globals). Aeries needs one new branch here (Aeries Student Portal hostnames, e.g. `*.aeries.net` — confirm exact pattern during the DevTools session already planned per SPEC §1) plus its name added to `SUPPORTED`.
3. **`FA.adapters.<name>`** (pattern shown in `adapters/canvas.js:72-148`) — an object with `name`, `matches(host)`, `fetchAssignments({includeFinished})`, and **optional** capability methods: `fetchClasses`, `fetchGrades(course)`, `fetchSchedule(from, days)`, `fetchTopics(course)`, `fetchICalLink`, `fetchProfile`, `markComplete`.
4. **`content.js`** (`content.js:25-31`) — `detectAdapter()` just iterates `Object.values(FA.adapters)` and picks whichever `matches(host)` returns true. No portal-specific code lives here or needs to be added.
5. **`lib/snapshot.js`** (`lib/snapshot.js:41-80`) — `FA.buildSnapshot(adapter)` uses a `has("fetchX")` capability check before calling each optional method, so a partial adapter (assignments only, no grades/schedule yet — exactly Aeries's likely v1 state) degrades gracefully to empty arrays instead of erroring. **This is the mechanism that lets Aeries ship incrementally** (assignments first, grades/schedule later) without touching snapshot.js at all.
6. **`lib/priority.js`** (`lib/priority.js:1-160`) — ranking, urgency scoring, the missing/overdue grace window, avoidance detection — all operate purely on the normalized Assignment shape (`type`, `dueDate`, `points`, `missing`, `finished`) and session history. It has **zero portal awareness** today (confirmed by reading the whole file) and must stay that way; Aeries needs nothing here.

### What must change outside `adapters/`

| File | Change needed | Why |
|---|---|---|
| `manifest.json` | Add Aeries origin(s) to `content_scripts[0].matches`, `content_scripts[0].js` (add `adapters/aeries.js`), and `host_permissions` | MV3 static content-script registration; without this the adapter file never loads on an Aeries tab |
| `background.js` | Add the same Aeries origin(s) to `PORTAL_MATCHES` (`background.js:189`) and `adapters/aeries.js` to `CONTENT_JS` (`background.js:190`) | `reinjectContentScripts()` and `detectCompletion()`'s portal poll both iterate `PORTAL_MATCHES`; skipping this means Aeries tabs silently never get re-injected after a reload and completion-by-portal-poll never fires for Aeries assignments |
| `adapters/detect.js` | New `SUPPORTED` entry + hostname/markup branch | Powers "connect my school" and the debug-info report (SPEC §1/§2) |

### An existing boundary leak — do not replicate it for Aeries

`content.js:103-109` (`MARK_COMPLETE` handler) calls `FA.adapters.blackbaud.markComplete(...)` **by name**, not through the detected adapter. This is a pre-existing violation of the adapter-boundary pattern everywhere else in the codebase. For Aeries:
- If Aeries doesn't support marking complete via API yet, do not add anything here — the capability-check pattern (`has("markComplete")`) already used in `lib/snapshot.js` is the correct model; a future fix would generalize `content.js`'s `MARK_COMPLETE` handler to call `detectAdapter().markComplete(...)` with a capability guard, which also fixes Canvas/Classroom (neither has `markComplete` today either).
- This is a pre-existing gap, not something Aeries needs to fix, but it is worth flagging to the roadmap as a small cleanup adjacent to adapter work rather than a blocker.

### Data flow (Addition 1)

```
Aeries Student Portal tab (session cookies only, no password ever stored)
   → adapters/aeries.js: adapter.fetchAssignments() (portal's own JSON/API endpoints,
      credentials: "include", same pattern as adapters/canvas.js:20-25)
   → adapters/schema.js: FA.makeAssignment(...) normalizes into the one Assignment shape
   → content.js: chrome.runtime.sendMessage({type:"CACHE_ASSIGNMENTS", ...}) → background.js
   → background.js: FA.store.cacheAssignments (lib/storage.js, chrome.storage.local)
   → lib/priority.js: FA.rankAssignments(...) — portal-agnostic
   → sidepanel/panel.js: renders the list, Smart Start, coach pick — portal-agnostic
```
Direction is one-way and unidirectional per portal tab: portal → adapter → schema → storage → rest of app. Nothing flows back into the adapter except `markComplete` (blackbaud-only today) and the one-time `portalOverride` read (`content.js:19-21`) for "connect my school" on an unrecognized domain of a supported adapter type.

### Build order / test gating

- No existing test suite exercises adapters at all today — `docs/SPEC.md` §1 explicitly lists "Adapter fixtures: ❌ none yet (gap)" and PROJECT.md's Active list has "Adapter fixtures and a `lib/priority.js` ranking unit test (current test gap)." **This means an Aeries adapter can be built and merged without risk of breaking `npm test`'s four suites (`security_tests.py`, `test-panel-boundary.js`, `test-background.js`, `test-docops.js`) — none of them touch `adapters/` or `content.js`.**
- Recommended order: (1) write `adapters/aeries.js` against a captured DevTools session (per the plan already in SPEC §1) with a fixture file mirroring `scripts/fixtures/mock-assignments.js`'s pattern, so the adapter has *something* to be tested against before a real account exists; (2) wire manifest.json/background.js/detect.js; (3) smoke-test by hand exactly as Canvas/Classroom currently are (⚠️ never run on a real account, per SPEC §1) — this is the same unproven state Canvas/Classroom are in, so Aeries is not a regression, it's parity; (4) if the roadmap picks up the "adapter fixtures" gap in the same milestone, build the fixture harness once and point it at Blackbaud, Canvas, Classroom, and Aeries together rather than writing four one-off harnesses.
- This addition has **no ordering dependency** on Additions 2 or 3 — fully parallelizable.

---

## Addition 2 — Work/break cadence in the focus clock

### The existing invariants that must not move

`background.js` and `test-background.js` together define a state machine around **one active session** (`FA.store.getActiveSession()` — a single record in `chrome.storage.local`, not portal- or type-specific). The guarantees under test (`scripts/test-background.js:1-14`, 14 cases) are:

1. A session survives a worker restart: `rearmActiveSession()` (`background.js:177-187`) is called from both `onStartup` and `onInstalled`, and re-arms `CHECKIN_ALARM` (at the exact planned-end timestamp) and `DETECT_ALARM` (every 1 min).
2. `CHECKIN_ALARM` fires exactly once at `plannedEnd(session)` (`background.js:602`, `605-612`) and triggers `timeUp()` which sets `timeUpAt` **once** (idempotent — a second fire does not chime again, tested explicitly).
3. `timeUpWatch()` (run every minute via `DETECT_ALARM`, `background.js:652-660`) stops the session **at the planned end** (not at 45s-later) if no answer arrives within `TIME_UP_GRACE_MS` (45s).
4. `extendSession()` (+5/+10) re-arms `CHECKIN_ALARM` at the new planned end and clears `timeUpAt`.
5. `idleWatch()` (`background.js:558-590`) independently stops the session after 10+5 quiet minutes, logging quiet time separately — this runs off the *same* `DETECT_ALARM`, not off `CHECKIN_ALARM`.
6. A `stopSession()` call after the panel already ended the session locally must be a no-op, not a throw (a client/server race the code already handles defensively).

**None of these can be repurposed for cadence.** The planned-end alarm (`CHECKIN_ALARM`) is "25 means 25" for the *whole sitting the student agreed to* (`FA.proposeChunk`, `lib/priority.js:132-147`); a 15/5 work/break cadence is a *subdivision inside* that sitting, not a replacement for it. SPEC §5 itself frames this as additive: "🎯 Planned (next): a work/break cadence... ❌ not built" sitting alongside the existing hard-stop language, not replacing it.

### Recommended component boundary

Add cadence as **session-record state**, not a new alarm type competing with the existing ones for meaning:

- Extend the active-session record (already a plain object under `FA.store` — see the fake in `scripts/test-background.js:23-45` for its shape: `startedAt`, `plannedMin`, `title`, `timeUpAt`, `lastActiveAt`, `idleAskAt`, …) with cadence fields, e.g. `cadence: {workMin, breakMin, phase: "work"|"break", phaseEndsAt}`.
- Add **one new alarm name**, e.g. `CADENCE_ALARM`, armed/cleared in the same four places the existing alarms are (`SESSION_STARTED`, `START_SESSION_FROM_PAGE`, `SESSION_ENDED`, `END_SESSION_FROM_PAGE`, `stopSession()`, `completeSession()`, and — critically — `rearmActiveSession()` so a cadence mid-break also survives a worker restart, exactly like the other two alarms already do). This is the same pattern as `CHECKIN_ALARM`/`DETECT_ALARM`, not a new mechanism.
- `CADENCE_ALARM`'s handler flips `session.phase` between `"work"` and `"break"`, re-arms itself for the next boundary, and — for a break the student "can't skip or extend" (SPEC §5) — needs a **panel-side enforcement companion**: the panel's own countdown UI (which independently handles the boundary "to the second" per SPEC §5's existing description of the planned-end UX) must disable/hide the +5/+10/skip controls while `session.phase === "break"`. The worker alarm is the backstop (survives a closed panel); the panel UI is the moment-to-moment experience — same division of labor the existing hard-stop already uses ("the panel handles the boundary itself... this alarm is the backstop for a closed panel," `background.js:246-247`).
- `idleWatch()` needs a one-line guard: do not fire "still there?" nudges while `session.phase === "break"` (a break is *supposed* to be quiet — the watchdog exists to catch a forgotten *work* timer, not to interrupt a mandated break). This is the one place existing logic must be touched, and it is an additive `if (session.cadence?.phase === "break") return;` at the top of `idleWatch()`, not a rewrite.
- The distraction watcher (`checkTabForDrift`, `background.js:861-902`) should also gate on phase: negotiating away from YouTube during work makes sense; negotiating during a break the app itself granted does not. Same one-line guard.

### What stays completely untouched

- `armTimeUpAlarm`, `timeUp`, `timeUpWatch`, `stopSession`, `plannedEnd` — the hard-stop machinery — take no cadence awareness. The planned sitting length is still the outer bound; cadence only decides what happens *inside* it.
- `rearmActiveSession()`'s existing two `chrome.alarms.create` calls are unchanged; a third call for `CADENCE_ALARM` (guarded by `if (session.cadence)`) is additive.
- `test-background.js`'s existing 14 cases assert behavior that has no cadence dependency (no test reads `session.phase`); they should keep passing unmodified as long as `CHECKIN_ALARM`/`DETECT_ALARM` semantics are untouched. New cadence-specific cases should be **added** to the same file (it already uses a from-scratch fake `chrome.alarms`/`FA.store`, so a cadence test slots in using the identical `makeWorker()` harness at `scripts/test-background.js:23-71`).

### Data flow (Addition 2)

```
SESSION_STARTED / START_SESSION_FROM_PAGE (panel → background.js)
   → armTimeUpAlarm() [unchanged: outer planned-end bound]
   → NEW: armCadenceAlarm() reads settings (default 15/5, per SPEC §5 "configurable?")
      → chrome.alarms.create(CADENCE_ALARM, {when: startedAt + workMin*60000})
      → session.cadence = {workMin, breakMin, phase:"work", phaseEndsAt}

chrome.alarms.onAlarm(CADENCE_ALARM)
   → flip phase, re-arm CADENCE_ALARM for the next boundary
   → chrome.notifications.create(...) + appendThread(...) same idiom as timeUp()/idleWatch()
   → panel (side panel is open) reflects phase via existing message/poll path, disables skip controls

DETECT_ALARM (1×/min, existing)
   → idleWatch(): NEW guard — skip nudge if phase === "break"
   → checkTabForDrift(): NEW guard — skip nudge if phase === "break"
```

### Build order / test gating

1. **First**, add `session.cadence` state + `CADENCE_ALARM` arm/clear wiring in all the same call sites `CHECKIN_ALARM`/`DETECT_ALARM` already use, verified by running `node scripts/test-background.js` after *every* edit — it is fast, loads the real `background.js` in a VM, and will immediately catch any accidental change to `armTimeUpAlarm`/`timeUp`/`timeUpWatch` semantics.
2. **Second**, add the `idleWatch`/`checkTabForDrift` phase guards — again gated by `test-background.js` (add 2-3 new cases exercising a `session.phase === "break"` fixture, following the existing `makeWorker({activeSession:{...}})` pattern) plus a manual check that break truly can't be skipped in the panel UI.
3. **Third**, wire the panel-side break UI (countdown display, disabled controls) — this touches `sidepanel/panel.js` but not the specific functions `scripts/test-panel-boundary.js` slices out (`devAllowed`, `applyRoleUI`, `applyDocOpsFromReply`, `autoActionsOnDone`, `formatMyDoc`, `initCoach`, `bridgeSig` — see `scripts/test-panel-boundary.js:29-34`), so that suite is unaffected unless the cadence UI work happens to touch one of those exact functions; confirm by re-running `node scripts/test-panel-boundary.js` after panel edits regardless.
4. `security_tests.py` and `test-docops.js` have no path into cadence logic at all (they exercise `bridge/coach_server.py` and `lib/docops.js` respectively) — no gating relationship.
5. This addition has **no dependency** on Addition 1 (adapters) and only a soft one on Addition 3 (a cadence "coach reacts to the break" notification could call the coach, but doesn't have to — the existing `appendThread`/`chrome.notifications` idiom used by `idleWatch`/`timeUp` needs no coach call at all).

---

## Addition 3 — Hosting the coach server off Ben's laptop

### What already exists (do not rebuild)

The deployment groundwork is **already built and unshipped**, not a green-field task:

- `deploy/Dockerfile` — API-engine-only image (`FROM python:3.12-slim`, `pip install anthropic`, runs `bridge/coach_server.py` unmodified with `FA_HOST=0.0.0.0`).
- `deploy/fly.toml` — Fly.io config: `auto_stop_machines = "stop"`, `auto_start_machines = true`, `min_machines_running = 0`, `shared-cpu-1x`/256mb, `FA_DAILY_CAP=300`.
- `deploy/focus-agent-bridge.service` — systemd unit for a plain VPS alternative, `Restart=always`.
- `deploy/README.md` — documents both paths end-to-end, including minting per-friend access codes (`python3 bridge/coach_server.py token alice`) and the explicit warning that plain HTTP must go behind HTTPS (Caddy one-liner) because codes travel in the `X-FA-Token` header.
- **The extension needs zero changes.** `lib/ai.js`'s `FA.bridgeSig(url, token)` (`lib/ai.js:1218`) and `FA.initCoach()` (`lib/ai.js:1221`) already resolve the bridge from a stored `{url, token}` setting, defaulting to `http://127.0.0.1:8000` (`lib/ai.js:462`) only when nothing is configured. The panel's ⚙ → coach server field is the only UI surface, and it already exists (per `deploy/README.md`'s "friends do this in 30 seconds" flow).

So the "component boundary between stays-exactly-as-is and must-change" is almost entirely **operational, not architectural**: get an API key, pick a host, run `fly deploy` (or the systemd path), mint codes. `bridge/coach_server.py` itself was already written defensively for this — `if HOSTED and not TOKENS: sys.exit(...)` and `if HOSTED and ENGINE not in ("api","mock"): sys.exit(...)` (`bridge/coach_server.py:1419-1422`) are exactly the "refuses to start without an API key" and "refuses claude-cli when hosted" guarantees PROJECT.md/SPEC.md already claim, and they are proven by `security_tests.py` today (`scripts/security_tests.py:357` spawns a hosted process with no tokens and asserts it refuses to start).

### The one place a shared host genuinely changes behavior: the daily cap

`_usage` (`bridge/coach_server.py:181-194`) is a plain in-process dict, `{(name, utc_day): count}`, guarded by a `threading.Lock` (fine — `ThreadingHTTPServer` is multi-threaded within one process, and the lock already handles that). The code's own comment is explicit that this is accepted, not a bug: *"Daily call cap per code (in memory; resets on restart, by decision)"* (`bridge/coach_server.py:218`).

The architectural question a shared host raises is **not** "does in-memory work" (it does, within one process) — it's **how often does the process restart**, because every restart silently resets every student's daily cap to zero:

- On Ben's Mac: restarts are rare (dev edits + manual restarts), so "resets on restart" in practice means roughly daily.
- On Fly.io with the checked-in `fly.toml` (`auto_stop_machines = "stop"`, `min_machines_running = 0`): the machine stops after a period of no traffic and **cold-starts on the next request**, which is a process restart. A student's cap could reset several times a day just from normal idle gaps (e.g., between school periods), making the cap materially weaker than "daily" in practice. This is a real behavior change introduced by hosting, not a hypothetical.

This is a **decision point**, not a code defect — and it is already named as an open decision in PROJECT.md's Active list ("Hosted coach server deployed off Ben's Mac with a real API key; always-on vs auto-stop policy decided"). Three architecturally valid resolutions, in order of least change:

1. **Accept it** — ship `fly.toml` as-is, document that the cap is "resets on restart" (already true today) and restarts happen more often when hosted. Zero code change. Cheapest ($0-3/mo per `deploy/README.md`).
2. **Flip the Fly policy, not the code** — set `min_machines_running = 1` and drop `auto_stop_machines` (always-on). Zero code change, restores "resets roughly daily" semantics, costs more (`deploy/README.md` doesn't quote this tier, but Fly's always-on shared-cpu-1x/256mb is still low; the tradeoff is entirely a `fly.toml` edit and a billing decision, not an engineering task).
3. **Persist `_usage` to disk** (a small JSON/SQLite file, in the same `~/.focus-agent/` directory pattern already used for `tokens`/`api_key`) so the cap survives restarts regardless of the Fly policy chosen. This is the only option that touches `bridge/coach_server.py` (`_count_call`, `_usage` at `bridge/coach_server.py:181-194`), and it is a narrow, additive change — the function's contract (`True` if within cap) doesn't change, only its storage backend.

None of these three options requires touching `Handler`, `_who()`, `_role()`, `_normalize_for_role()`, the origin check, the body-size cap, or any `BUILDERS[method]` — i.e., none of them touch anything `security_tests.py`'s 75 cases actually assert on (confirmed: no existing case exercises `_count_call`/429 behavior at all — `grep` for `cap|429|DAILY_CAP` in `scripts/security_tests.py` finds only unrelated "reply LENGTH CAP" prompt-string checks). If option 3 is chosen, this is also a **coverage gap to close**, not a suite to merely keep green: add a new `security_tests.py` case that starts a bridge, exhausts `FA_DAILY_CAP` calls for one code, asserts 429, restarts the process (or simulates a restart), and asserts the persisted count survived — there is no such case today.

### The second real consideration: single-machine assumption

`_usage` is process-local. `fly.toml`'s `min_machines_running = 0` with default Fly scaling keeps this to one machine most of the time, but nothing in the checked-in config *hard-caps* concurrency at one machine under load. If Fly ever runs two machine instances concurrently (e.g., a future `[http_service.concurrency]` block or manual scale-up), each machine has its own independent `_usage` dict, silently doubling the effective daily cap per code — a soft security/cost regression, not a crash. This is worth a one-line note in `deploy/fly.toml` or `deploy/README.md` ("do not scale beyond 1 machine without also persisting `_usage`") rather than a code change now, since the current config does not do this.

### Data flow (Addition 3)

```
Student's extension (⚙ → coach server: URL + access code, saved via chrome.storage)
   → lib/ai.js FA.initCoach() / FA.bridgeSig(url, token) resolves which bridge+code to use
   → fetch(`${url}/coach`, {headers: {Origin: chrome-extension://<id>, "X-FA-Token": code}, body})
   → [NEW: the same request now crosses the public internet to Fly/VPS instead of
      127.0.0.1 — this is the only actual change; HTTPS is mandatory here (already
      called out in deploy/README.md) since it wasn't needed for loopback traffic]
   → Handler.do_POST("/coach"): origin check → _who()/_role() → _count_call()
      → [decision point: in-memory vs persisted, per above] → BUILDERS[method] → model
   → response: fixed-shape JSON only, no request text ever in logs (unchanged guarantee,
      `_pseud(who)` + method name + error class only, `bridge/coach_server.py:1284-1400`)
```
Direction: strictly extension → server → model provider → server → extension. The server never initiates contact with the extension or the portal. Hosting changes only the network hop between "extension" and "server," not the shape or direction of any message.

### Build order / test gating

1. This addition is **entirely decoupled** from Additions 1 and 2 — no shared files, no shared runtime state. It can be done first, last, or in parallel.
2. If the team picks resolution 1 or 2 above (accept the reset semantics, or flip the Fly policy) — this is a `deploy/fly.toml` + secrets edit and a real API key, gated by nothing but a manual `curl https://<app>.fly.dev/health` check and `deploy/README.md`'s own instructions. `npm test`'s four suites are unaffected because no source file changes.
3. If the team picks resolution 3 (persist `_usage`) — gate on `python3 scripts/security_tests.py` continuing to pass unmodified (it should, since the change is additive to `_count_call`'s internals only) **plus** a new case added for the cap-survives-restart behavior before considering the change done, since today's suite is silent on this exact behavior.
4. Either way, get the real `ANTHROPIC_API_KEY` and decide the auto-stop policy **before** minting friend access codes — `deploy/README.md`'s own sequencing (`fly secrets set` before `fly deploy` before handing out codes) already encodes the right order.

---

## Cross-cutting build order (all three additions)

| Step | What | Gated by | Depends on |
|---|---|---|---|
| 1 | Aeries adapter (`adapters/aeries.js` + manifest/background/detect wiring) | Nothing in `npm test` today (adapters are untested); manual smoke parity with Canvas/Classroom's current unproven state | Nothing |
| 2 | Coach server hosting decision + deploy | `security_tests.py` (unmodified if resolution 1/2; +1 new case if resolution 3) | Nothing (parallel to 1) |
| 3 | Cadence state + alarm wiring in `background.js` | `node scripts/test-background.js` after every edit (existing 14 cases must stay green; add cadence-specific cases) | Nothing (parallel to 1, 2) |
| 4 | Cadence panel UI (break screen, disabled skip controls) | `node scripts/test-panel-boundary.js` (only at risk if the work happens to touch the exact sliced functions — check by re-running) | Step 3 (needs `session.phase` to exist) |
| 5 | Full `npm test` run (`security_tests.py && test-panel-boundary.js && test-background.js && test-docops.js`) | This is the existing pre-friends-build gate (`package.json:7`, and `scripts/package-store.sh` per SPEC §21) | Steps 1-4 |

All three additions can be branched and built in parallel by different people/sessions since they touch disjoint files (`adapters/*` + manifest/background registration lines vs. `background.js`'s alarm logic vs. `bridge/`/`deploy/`), with the single shared file being `background.js` (touched by both Addition 1's `PORTAL_MATCHES`/`CONTENT_JS` constant updates and Addition 2's alarm logic) — a small, easily-rebased overlap, not a true dependency.

---

## Anti-patterns to avoid (specific to this codebase)

### Anti-pattern 1: Teaching `lib/priority.js` or `lib/snapshot.js` about a portal
**What it would look like:** an `if (assignment.source === "aeries")` branch in `urgencyScore` or `buildSnapshot`.
**Why it's wrong:** the entire value of `adapters/schema.js`'s normalization is that ranking, snapshot-building, and the panel are portal-blind today (confirmed: `lib/priority.js` has zero source-specific logic). One portal-aware branch anywhere downstream breaks that invariant for every future adapter, not just Aeries.
**Do this instead:** if Aeries needs a ranking nuance (e.g., a field Blackbaud doesn't have), add it as a new normalized field on the Assignment shape (via `FA.makeAssignment`) and let `priority.js` treat it as a generic field, the same way `missing` and `points` already work across all adapters.

### Anti-pattern 2: Repurposing `CHECKIN_ALARM` to also mean "cadence boundary"
**What it would look like:** overloading `armTimeUpAlarm`'s single alarm to fire at the next work/break boundary instead of (or in addition to) the planned end, to "save an alarm."
**Why it's wrong:** `CHECKIN_ALARM`'s entire tested meaning is "the hard stop, exactly once, idempotent" (`test-background.js`'s core assertions). Cadence needs to fire *repeatedly* inside a sitting; conflating the two collapses two different guarantees (hard stop vs. periodic phase change) into one alarm and makes the existing 14 test cases unable to distinguish them.
**Do this instead:** a second, independent alarm (as described above) — `chrome.alarms` has no meaningful limit relevant here (`COMMITMENT_ALARM` and `NIGHTLY_ALARM` already coexist with `CHECKIN_ALARM`/`DETECT_ALARM` today).

### Anti-pattern 3: Treating hosted-server work as "rewrite the coach server"
**What it would look like:** starting a new deployment-focused rewrite of `bridge/coach_server.py` (e.g., moving to a framework, adding a database, splitting into microservices) because "it needs to run on a real host now."
**Why it's wrong:** `deploy/` already proves the existing single-file script runs unmodified in Docker/Fly/systemd; `security_tests.py` already spawns it as a subprocess and asserts hosted-mode refusals work. A rewrite would both violate "never logs request text"/"tutor mode forced server-side" guarantees by re-deriving them from scratch, and would discard 75 already-passing security tests' relevance.
**Do this instead:** ship the existing `deploy/` artifacts as-is; touch `coach_server.py` only for the narrow, additive `_usage`-persistence change if that specific tradeoff is chosen.

---

## Integration points summary

| Boundary | Communication | Notes |
|---|---|---|
| Aeries portal tab ↔ `adapters/aeries.js` | `fetch(..., {credentials:"include"})` against the portal's own session-authenticated endpoints, same idiom as `adapters/canvas.js:20-25` | Cookies never leave the browser; adapter runs inside the student's own logged-in page |
| `adapters/aeries.js` ↔ rest of extension | `FA.makeAssignment(...)` normalized objects only, via `content.js`'s `chrome.runtime.sendMessage` | The only contract; adapter internals are invisible past this point |
| Side panel / overlay ↔ `background.js` (cadence) | `chrome.runtime.sendMessage` (existing `SESSION_STARTED`/`GET_COACH_STATE`-style messages) + `chrome.alarms` for the worker-side backstop | Panel handles the moment-to-moment UI; worker is the reload/restart-survival backstop — same split as the existing hard-stop |
| Extension ↔ coach server (hosted) | `POST https://<host>/coach` with `Origin: chrome-extension://<id>` and `X-FA-Token: <code>`, HTTPS required once off loopback | Zero extension-side code change; `FA.bridgeSig`/`FA.initCoach` already parameterized (`lib/ai.js:462,1218,1221`) |
| Coach server ↔ model provider | `anthropic` SDK (API engine) once `ANTHROPIC_API_KEY` is set; `claude-cli` engine explicitly refused when `HOSTED` (`bridge/coach_server.py:1421-1422`) | Hosted must be the API engine — already enforced |

## Sources

All findings are drawn directly from the current repository (HIGH confidence — primary source, not third-party documentation):
- `adapters/schema.js`, `adapters/detect.js`, `adapters/canvas.js`, `content.js`, `lib/priority.js`, `lib/snapshot.js`, `manifest.json`
- `background.js` (full file), `scripts/test-background.js` (full file)
- `bridge/coach_server.py` (full file, 1433 lines), `scripts/security_tests.py` (structure + `grep` for cap/429 coverage)
- `scripts/test-panel-boundary.js`, `scripts/test-docops.js` (headers, to establish what each suite actually gates)
- `deploy/Dockerfile`, `deploy/fly.toml`, `deploy/README.md`, `deploy/focus-agent-bridge.service`
- `docs/SPEC.md` §1 (portal adapters), §5 (focus clock), §19 (coach server), §23 (known gaps)
- `.planning/PROJECT.md`, `package.json`

---
*Architecture research for: Focus Agent — subsequent milestone, three integration additions*
*Researched: 2026-09-17*
