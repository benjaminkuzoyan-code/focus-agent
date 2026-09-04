# Focus Agent

AI focus coach for students. Reads assignments from your school portal
(Blackbaud, Canvas, Google Classroom), learns how you actually work and
coaches you through it — triage, timers, streaks, boss battles.

**The unfair advantage:** real portal data + your real focus history + a
coach that sees both. Blockers don't know your homework; homework apps
don't know your behavior. This knows both.

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder
4. Pin the extension. The toolbar popup is the mini view; the **side panel**
   (button in the popup) is the real coach.

After editing any file, hit refresh on the extension card. **Then also
refresh any open portal tabs** — pages loaded before the reload keep
running orphaned scripts, and every button on them throws
"Extension context invalidated" until the page is refreshed.

## Project structure

```
focus-agent/
├── manifest.json        # MV3 config: hosts, permissions, side panel
├── content.js           # Thin router: detects the portal, runs its adapter
├── background.js        # Alarms, check-ins, distraction watcher, receipts
├── adapters/
│   ├── schema.js        # THE normalized Assignment shape + helpers
│   ├── blackbaud.js     # DataDirect API (verified on polytechnic.myschoolapp.com)
│   ├── canvas.js        # Canvas planner/todo API (UNTESTED — friend's machine)
│   ├── classroom.js     # Classroom DOM scrape (UNTESTED — friend's machine)
│   └── mock.js          # Demo data — the default all summer
├── lib/
│   ├── storage.js       # Sessions, streaks, commitments (all on-device)
│   ├── priority.js      # Urgency scoring + PERSONAL pace estimates
│   ├── forecast.js      # Focus Forecast (weather for your week)
│   ├── xp.js            # XP, levels, boss battles
│   └── ai.js            # Coach interface: MockCoach now, ClaudeCoach later
├── sidepanel/           # Main UI: Today / Panic / Timer / Stats / Quests
└── popup/               # Mini "what's next" + Panic shortcut
```

## The features

| Feature | What it does | Status |
|---|---|---|
| Today view | Assignments ranked by urgency × your measured pace | ✅ |
| Coach pick | "Work on X, here's why" | ✅ (MockCoach) |
| Panic Button | Minute-by-minute triage when you're screwed; honest sacrifices | ✅ |
| Smart Start | One click: opens the right tabs, parks distractions, starts timer | ✅ |
| Focus timer + streaks | Sessions logged on-device; streak survives an off day | ✅ |
| Check-ins | "Still on it?" notifications mid-session | ✅ |
| Distraction negotiation | Drift to YouTube → coach bargains with receipts, doesn't block | ✅ |
| Focus Forecast | 7-day workload weather + "start Tuesday" headline | ✅ |
| Procrastination Autopsy | Your real patterns from real sessions | ✅ |
| Boss Battles | Tests = bosses; lead-up work drains their HP | ✅ |
| Commitment Receipts | "You said 4pm" — the coach remembers | ✅ |
| Page coach overlay | Badges + "START HERE" drawn on the actual portal rows; floating coach bubble with live timer HUD | ✅ v0.3 |
| Doc Starter | One click: titled Google Doc created, outline on your clipboard | ✅ v0.3 |
| Annotate any page | Highlighter/pen canvas over any webpage, saved per-URL | ✅ v0.3 |
| Real analytics | Focus trend charts, power hours, distraction cost by site | ✅ v0.3 |
| Teach-It-To-Claude, auto-flashcards, Sunday Briefing, Sleep Guardian | Needs the Claude API key | 🔜 |
| Squad sessions, crowd difficulty, parent digest | Needs a backend | 🔜🔜 |

## The bridge server (demo portal + REAL Claude brain, no API key)

One server does both: serves the fake Blackbaud in `demo-portal/` AND gives
the extension a real Claude brain via headless Claude Code (`claude -p`),
which uses Ben's existing login — no API key required.

```bash
cd ~/Projects/focus-agent
python3 bridge/coach_server.py
```

With the bridge running, the side panel shows 🧠 and the coach's picks,
panic triage, breakdowns, and autopsy come from actual Claude (~5-20s per
call, upgraded in place over the instant rules version). Without it, the
extension shows ⚙️ and falls back to the built-in rules — nothing breaks.
Each brain call spends a little of Ben's Claude plan quota. When the API
key lands, the bridge's `claude -p` swaps for a real API call and nothing
else changes.

Then open **http://localhost:8000/demo-portal/** — within ~2 seconds you
should see priority badges appear on the assignment rows (glowing
"▶ START HERE" on the coach's pick) and the coach bubble bottom-right.

> The `http://localhost:8000/*` manifest entry and `adapters/demo.js` are
> dev-only — remove both before any public/Web Store release.

## Test checklist

### On this machine (mock data — do these now)
- [ ] Load unpacked → open side panel → Today list renders with ranked mock assignments
- [ ] Coach box picks the overdue item first with a reason
- [ ] Forecast strip shows a storm on the crunch day; headline names it
- [ ] Panic tab → 120 min → schedule renders; every due-soon item is scheduled OR listed as a sacrifice
- [ ] Smart Start on any assignment → its tab opens, timer starts, panel switches to Timer
- [ ] End the session → Stats shows it; streak becomes 🔥 1
- [ ] Set a commitment 2 minutes out → wait → "Receipts 🧾" notification fires; button resolves it
- [ ] During a session, open youtube.com → negotiation notification (max one per 2 min)
- [ ] Check-in test: in `lib/storage.js` settings, checkinMin default is 10 — temporarily set to 1, reload, start session, expect a check-in notification within ~1 min. **Set it back.**
- [ ] Close and reopen the panel mid-session → timer restores from storage
- [ ] Quests tab → Biology test appears as a boss; mark its lead-up work done → HP drops
- [ ] Restart Chrome → sessions/streak/XP all still there

### v0.3 features (mock data / any page)
- [ ] Stats tab: 4 charts render (daily minutes, power hours, distraction trend, top sites) — empty-state notes if no sessions yet
- [ ] Run a session, drift to YouTube → afterwards the site shows in "What's costing you" with a refocus estimate
- [ ] Any normal webpage → panel ✏️ button → toolbar appears → highlight + pen + erase work → scroll (strokes anchored) → close → reopen annotator → strokes restore → 🗑️ clears
- [ ] Today tab, essay card → "📄 Start the doc" → titled Google Doc opens, Cmd+V pastes the outline → button becomes "Open your doc" and reopens the same doc
- [ ] Portal page (myschoolapp.com, even empty) → coach bubble appears bottom-right, no console errors; with assignments (fall/Canvas), rows get badges and the pick glows "START HERE"
- [ ] Bubble "Start focus" → mini timer HUD counts on the page; "Done" ends the session and it shows in Stats

### On a friend's machine (Canvas)
- [ ] They log into Canvas; you load the unpacked extension (or pack it first)
- [ ] Side panel → source dropdown → "My portal" → their real assignments appear normalized
- [ ] If it fails: open DevTools on the Canvas tab, look for `[Focus Agent]` errors — the API paths in `adapters/canvas.js` are the suspects
- [ ] Check course names resolved (not blank) and due dates parse

### On a friend's machine (Google Classroom)
- [ ] Open classroom.google.com → menu → **To-do** view first (the scraper reads that page)
- [ ] Source → "My portal" → assignments appear
- [ ] Expect selector fixes in `adapters/classroom.js` — Google's DOM is obfuscated; that file is built to be tweaked

### This fall (Blackbaud, when real assignments exist)
- [ ] Verify field mapping in `adapters/blackbaud.js` against a real assignment (`raw` is kept on every item — compare in the console)

## Rules of the road

- **The Claude API key never ships in this extension.** ClaudeCoach goes live
  behind a small backend, later. MockCoach keeps everything testable free.
- **All student data stays on-device** (`chrome.storage.local`). That's the
  privacy pitch to parents and schools, and it stays true until there's a
  real reason and a real consent flow.
