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
│   └── detect.js        # Which school system is this page? (connect my school / debug info)
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

**25 means 25** (v0.8.9): the sitting has a hard end. At the planned minutes: a chime (from the panel, or from an offscreen document when the panel is closed — it only plays once), the ring goes amber, and one card asks *keep going?* with **+5 min · +10 min · done ✓ · stop** and a visible **45-second countdown**. No answer → the clock stops **at the planned end**, so the log says 25, never 25-plus-whatever; the done view opens (or a notification says so if the panel was shut). Panel closed? The same ask arrives as a notification with *+5 min* / *stop ✓*, and the worker stops the clock on its next minute tick. The old repeating "Focus check-in" notification is gone — the end-of-sitting ask replaces it.

**📸 Annotate anything** (v0.8.9): the text highlighter can't touch Google Docs (drawn on a canvas), Drive previews, images or scanned pages. The **📸** header button (and *📸 annotate my screen* behind ⋯) screenshots the visible tab — *your* copy of the pixels, nothing read from the page — lets you **drag a region** (click = whole screen, Esc = cancel), and sends it to the coach: with nothing typed you get a **page overview** (what it is, key ideas, questions you should be able to answer, quotes worth highlighting); type a question in the chat box first and you get an answer about what's visible. The page's text joins the assignment's files, so summaries, quiz me and practice tests can use it. Tapping **🖍** on a Google Doc or an image now goes this route instead of a dead end. Bridge method `readScreen`; the API engine gets a real image block, the `claude -p` engine reads a temp file with its Read tool (this also fixed *📷 photo of my work*, which had silently stopped seeing the photo since v0.8.5). Only the small thumbnail in the thread is stored.

**The clock can't run away** (v0.8.7): the ring is the clock — 180px, elapsed in the middle, fills over the chunk, amber past it. Every minute the worker checks for signs of life (mouse/keyboard anywhere via `chrome.idle`, tab switches, doc edits, taps in the panel). Ten quiet minutes → **"Still there?"** as a notification and in the chat, with *still here ✓* / *stop the clock*. Five more minutes without an answer → the clock stops **at the last sign of life**, the quiet minutes are logged separately (`idleMin`) and never counted, and the done view says so. No session running → the ring is a **▶ start N min** button pre-set to the Ramp proposal. The done view also shows your estimate calibration per course ("your English II guesses run 2.4× short") once two finished assignments exist.

**The timer is the work** (v0.7.2): no countdown to babysit. Smart Start starts the clock; the coach proposes this sitting's length from *your* history (**Ramp**: 5–25 min, the why shown next to the chips, tap to change), and at the chunk boundary posts a visible checkpoint — "14 min in, 2/5 steps, is *X* done?" with one-tap answers. The session ends when the job does: the assignment **vanishing from myPoly's pending list** (you marked it complete or submitted) closes the session and opens the done view even with the panel shut; a Google Doc untouched for 8 min or a closed assignment tab makes the coach *ask*, never decide. **Paper mode**: no doc and no tab activity in the first chunk → the clock keeps running, check-ins arrive as notifications, done = tap or mark complete in myPoly. Every stop is recorded with what ended it.

Still running underneath: tab parking (distractors move to a minimized window — nothing closed), distraction negotiation with receipts, check-in notifications, Focus Forecast, avoidance detection, streaks.

**Your writing voice** (v0.8.1): ⚙ → *your writing voice*. Add pieces you wrote — paste, files (txt/md/pdf), the Google Doc in the active tab, or pick from your recent Drive docs — and **import mine** pulls the style guide (and any sample files) from `~/.claude/skills/essay/` through the bridge. A profile is built automatically (the brain reads the prose; a stats profile when offline) and rides along on everything the coach writes for you: steps, answers, edits, chat in dev/answer mode. **Learn from essays I finish** (on by default) adds a finished assignment's doc as a sample when you hit done, but only if the coach never wrote into it. Everything stays on the device.

**Practice test** (v0.8.8): the **practice test** chip (primary on a test, behind `⋯` on anything else) builds a graded test from your files and highlights — multiple choice, true/false, short answer — right in the thread. Submit for a score; short answers that don't match exactly get an *I got it / missed it* self-mark. Then: *retake misses*, *more like the misses*, *harder*, `✎` to fix any question, *+ my own* to write one, *copy for Quizlet* (term ⇥ answer, one card per question) with an *open Quizlet* shortcut to the import page. Tests persist per assignment, so *clear chat* keeps them. Bridge method `practiceTest`; rules fallback turns definition sentences into short-answer / multiple-choice questions.

**Study mode** (v0.8.0): when the assignment is a test or quiz, more chips appear in the work view — **quiz me** (now behind `⋯`; (one question at a time from your files and course topics; honest ✓/✗ grading with a running score; misses come back later), **flashcards** (from your files and highlights; tap to flip; *copy for Quizlet* puts them on the clipboard as term ⇥ definition), **study plan** (one 20-minute session per day until the test, added to your checklist; last day is a no-notes self-quiz).

**Other schools** (v0.8.0): ⚙ → **connect my school** while your school's assignment page is open. Canvas works on any domain (not just instructure.com); Blackbaud and Google Classroom too. Unsupported systems (Schoology, PowerSchool, Brightspace, Blackboard, Moodle…) are recognised and named. **copy debug info** copies a report — version, portal detected, adapter result, snapshot errors, never cookies or passwords — to paste to Ben.

**Chat hygiene:** each assignment's chat is its own; finishing an assignment clears it (steps and files stay); starting a new Smart Start clears the general chat; **clear chat** wipes the current one.

**Files the coach can see** (v0.7.7): every assignment has a files box in the work view. Drop a PDF or text file on it, tap **+ this tab** to attach the page / Google Doc / PDF you're reading, or let Smart Start file what it opened. Text is extracted once (Docs API, bundled pdf.js, or the page's main text) and cached per assignment, so the coach still sees the reading — and your highlights and notes on it — whichever tab is active. This is the assignment's memory.

**format my doc** (every build, v0.7.5): one chip restyles the assignment's Google Doc — MLA by default (Times New Roman 12, double-spaced, 1" margins, centered title, indented paragraphs, `- ` lines become real bullets). Formatting only: it never changes a word. Index math lives in `lib/docops.js` (pure, unit-tested by `scripts/test-docops.js`).

**Developer mode** (⚙ → settings) is Ben's build — the coach does the work. Off by default; never on in the student build:
- `write this step` — the coach writes the current step, finished, **into your Google Doc** (a headed block at the end) and checks it off; without a doc it lands in the chat to paste.
- `answer these` — every question answered, into the doc or the chat.
- `📷 photo of my work` — snap paper work; the coach (via the bridge, which saves the photo and reads it) checks off the steps it can see and gives one line of feedback.
- `mark it complete` — ticks the assignment in myPoly. **Pending a spike:** `adapters/blackbaud.js` `markComplete` throws until the portal's own request is captured (DevTools → Network → tick an assignment by hand → copy URL/method/body).
- **chat can write:** with a doc attached and Google connected, asking the coach in chat to write/fix/format something in the doc makes it answer with a `docops` block that is applied in place (never in the student build).
- `edit my doc…` — type an instruction; the coach reads the doc as numbered paragraphs and returns edit ops (replaceAll, setStyle, insertAfter, replaceParagraph, deleteParagraph, append, replaceBody) that are applied in place. Full write access, anywhere in the doc.
- **🚀 autopilot** (chip, or *autopilot on Smart Start* setting) — opens every teacher link and the module, creates the Google Doc with the outline, writes every unchecked step into it in order and checks them off (worksheets with no doc → answers in chat; tests → study plan + flashcards). Never finishes or submits by itself.
- **auto-actions on done** (setting) — tick complete in myPoly + a Calendar block for the next item, reported under the debrief.
- **nightly auto-plan** (setting) — 4:30pm: rank the cached assignments, build tonight's plan (same engine as the time chips), write the blocks to Google Calendar, one notification. S04 does this by hand in ChatGPT every night.

Cut in v0.7: boss battles, the Quests tab, the Panic tab (now the time chips), the Timer tab (now the work view), per-card Explain/Pre-check/Break-down buttons (now chips inside the work view).

## The bridge server (the REAL Claude brain)

`python3 bridge/coach_server.py` runs on `127.0.0.1:8000` and answers the extension's coach calls. Two engines, picked when it starts:

- **API** (fast, the real thing): put your Anthropic API key in `~/.focus-agent/api_key` (one line) or export `ANTHROPIC_API_KEY`, and `pip3 install anthropic` once. Replies in a few seconds; the coach's identity and help policy ride in a real system prompt. `FA_EFFORT=high` for deeper, slower answers (default `medium`); `FA_API_MODEL` to change the model.
- **claude-cli** (fallback, no key): headless `claude -p` with your Claude Code login. 10-60s per call and it hit the 150s timeout on ~8% of calls in the log — use it only until the key lands.

Restart the bridge after editing it — the panel shows **🧠 bridge needs restart** when its code is stale, and ⚙ → the brain badge says which engine is live.

**Roles (v0.8.10):** the bridge decides who is a developer. An access code minted with `python3 bridge/coach_server.py token ben dev` (or listed in `FA_DEV_TOKENS`) gets developer mode, answer mode and the writing methods; every other code is a student: the server forces tutor mode before any prompt is built, refuses `writeStep` / `answerAll` / `editDoc` with 403 before any model call, and turns 📸 page overview into orientation only. The ⚙ developer switch only works for a code the server already calls dev. Browser origins other than `chrome-extension://…` are refused (`FA_ALLOW_ORIGINS` for the dev harness only); bodies over `FA_MAX_BODY` get 413; a hosted bridge refuses to start without the API engine; request framing and images are validated before any model call; the client only ever sees fixed error sentences (provider explanations and tracebacks stay in the process) and logs carry a pseudonymous id, the method name and the error class. The panel enables developer controls only on a positive, current `dev` answer from the server for the exact server + code in settings. `python3 scripts/security_tests.py` (75 cases, mock engine) and `node scripts/test-panel-boundary.js` (28 cases, real panel functions in a VM) prove it; run both before packaging.

**Friends:** their machines don't have a bridge, so host one — `deploy/README.md` has the Fly.io and VPS recipes. Each friend gets an access code (`python3 bridge/coach_server.py token <name>`, or `FA_TOKENS=name:code,…` on the server) and pastes the server address + code into ⚙ → coach server. Codes are capped at `FA_DAILY_CAP` calls a day. The API key stays on the server.

**Coach voice:** casual, direct, like a sharp older friend — set in `COACH_IDENTITY` in `bridge/coach_server.py`. The tutor policy holds back only the final answer to graded work and says so in one line; answer mode and developer mode hand things over, including again after a cleared chat. Your writing-voice profile applies only to text the coach writes *for* you, never to how it chats.

**Chips:** the work chat shows three (`I'm stuck` · `explain` · `check my draft`, plus `practice test` on a test) and a `⋯` that reveals the rest — quiz me, break it down, 5 more minutes, format my doc, flashcards, study plan, clear chat, and the developer chips.

## Test checklist

### On this machine (do these now)
- [ ] Load unpacked → open side panel → Today list renders with your ranked assignments (portal tab open)
- [ ] Coach box picks the overdue item first with a reason
- [ ] Forecast strip shows a storm on the crunch day; headline names it
- [ ] Panic tab → 120 min → schedule renders; every due-soon item is scheduled OR listed as a sacrifice
- [ ] Smart Start on any assignment → its tab opens, timer starts, panel switches to Timer
- [ ] End the session → Stats shows it; streak becomes 🔥 1
- [ ] Set a commitment 2 minutes out → wait → "Receipts 🧾" notification fires; button resolves it
- [ ] During a session, open youtube.com → negotiation notification (max one per 2 min)
- [ ] Time's-up test: start a 5-min sitting, wait it out — expect the chime + the *keep going?* card with a 45 s countdown; let it run out and the done view should show exactly 5 min. Close the panel and repeat: a notification with *+5 min* / *stop ✓* instead.
- [ ] Close and reopen the panel mid-session → timer restores from storage
- [ ] Quests tab → Biology test appears as a boss; mark its lead-up work done → HP drops
- [ ] Restart Chrome → sessions/streak/XP all still there

### v0.3 features (any page)
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
