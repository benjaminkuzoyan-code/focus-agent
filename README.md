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

## The features (v0.7 — one screen)

The side panel is **one screen in three states**. Everything else lives behind ▸more.

| State | What you see | Status |
|---|---|---|
| **list** | Every pending assignment ranked by urgency × your pace, one button each: **▶ Smart Start**. "tonight I have 30m/1h/1.5h/2h" turns the list into a triage plan with honest sacrifices. | ✅ |
| **work** | The assignment you're on: elapsed clock + chunk bar, an **editable checklist** (the breakdown: ⋯ → smaller / why / move / remove, add your own), and the **coach chat scoped to this assignment** — it opens with what it set up and asks a question when the instructions are unclear. Chips: explain · break it down · check my draft · I'm stuck · 5 more minutes. | ✅ |
| **done** | Minutes this sitting vs your guess, one debrief line, and the next pick with its own ▶. | ✅ |
| **▸more** | Classes + grades + this week + phone alerts (iCal), stats + autopsy, XP level, commitments, general chat, settings (Google, tutor/answer, data source, ✏️ draw, developer mode). | ✅ |

**Highlight anything → three bubbles** (v0.7.1): on any site Smart Start opened (permission asked once per site) and on PDFs (opened in our bundled pdf.js viewer), select text and get **🖍 annotate** (text-anchored highlight; the coach pencils a *question* in the margin, you write the note), **≡ summarize** (Chrome's on-device Summarizer first — free, private — then the coach brain), **? ask** (the coach, scoped to that passage). Notes, summaries and answers land in the assignment's chat thread while a session runs. Highlights survive reload and reflow. Nothing fires on hover.

**The timer is the work** (v0.7.2): no countdown to babysit. Smart Start starts the clock; the coach proposes this sitting's length from *your* history (**Ramp**: 5–25 min, the why shown next to the chips, tap to change), and at the chunk boundary posts a visible checkpoint — "14 min in, 2/5 steps, is *X* done?" with one-tap answers. The session ends when the job does: the assignment **vanishing from myPoly's pending list** (you marked it complete or submitted) closes the session and opens the done view even with the panel shut; a Google Doc untouched for 8 min or a closed assignment tab makes the coach *ask*, never decide. **Paper mode**: no doc and no tab activity in the first chunk → the clock keeps running, check-ins arrive as notifications, done = tap or mark complete in myPoly. Every stop is recorded with what ended it.

Still running underneath: tab parking (distractors move to a minimized window — nothing closed), distraction negotiation with receipts, check-in notifications, Focus Forecast, avoidance detection, streaks.

**Files the coach can see** (v0.7.7): every assignment has a files box in the work view. Drop a PDF or text file on it, tap **+ this tab** to attach the page / Google Doc / PDF you're reading, or let Smart Start file what it opened. Text is extracted once (Docs API, bundled pdf.js, or the page's main text) and cached per assignment, so the coach still sees the reading — and your highlights and notes on it — whichever tab is active. This is the assignment's memory.

**format my doc** (every build, v0.7.5): one chip restyles the assignment's Google Doc — MLA by default (Times New Roman 12, double-spaced, 1" margins, centered title, indented paragraphs, `- ` lines become real bullets). Formatting only: it never changes a word. Index math lives in `lib/docops.js` (pure, unit-tested by `scripts/test-docops.js`).

**Developer mode** (⚙ → settings) is Ben's build — the coach does the work. Off by default; never on in the student build:
- `write this step` — the coach writes the current step, finished, **into your Google Doc** (a headed block at the end) and checks it off; without a doc it lands in the chat to paste.
- `answer these` — every question answered, into the doc or the chat.
- `📷 photo of my work` — snap paper work; the coach (via the bridge, which saves the photo and reads it) checks off the steps it can see and gives one line of feedback.
- `mark it complete` — ticks the assignment in myPoly. **Pending a spike:** `adapters/blackbaud.js` `markComplete` throws until the portal's own request is captured (DevTools → Network → tick an assignment by hand → copy URL/method/body).
- **chat can write:** with a doc attached and Google connected, asking the coach in chat to write/fix/format something in the doc makes it answer with a `docops` block that is applied in place (never in the student build).
- `edit my doc…` — type an instruction; the coach reads the doc as numbered paragraphs and returns edit ops (replaceAll, setStyle, insertAfter, replaceParagraph, deleteParagraph, append, replaceBody) that are applied in place. Full write access, anywhere in the doc.
- **auto-actions on done** (setting) — tick complete in myPoly + a Calendar block for the next item, reported under the debrief.
- **nightly auto-plan** (setting) — 4:30pm: rank the cached assignments, build tonight's plan (same engine as the time chips), write the blocks to Google Calendar, one notification. S04 does this by hand in ChatGPT every night.

Cut in v0.7: boss battles, the Quests tab, the Panic tab (now the time chips), the Timer tab (now the work view), per-card Explain/Pre-check/Break-down buttons (now chips inside the work view).

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
