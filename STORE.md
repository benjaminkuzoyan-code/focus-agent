# Chrome Web Store Readiness — Audit & Listing Draft

Status: PRE-SUBMISSION. Nothing here goes live until fall validation is done
(Ben + classmates, retention proven). This file is the working audit so
submission day is a checklist, not a scramble.

Update 2026-08-10: the **unlisted** submission (checklist steps 3-7) can
happen BEFORE fall validation — the store build is already rules-only (the
bridge is stripped at packaging, so step 2's "ship without AI" branch is
the current state), and unlisted means only people with the link install
it. Fall validation gates the flip to PUBLIC, not the unlisted upload.
Supporting docs now in the repo: PARENTS.md (parent steps) and site/
(landing page + hostable privacy policy for step 4 — GitHub Pages ready).

## Permission audit (every permission, why we have it, reviewer justification)

Chrome reviews data-touching extensions hard. Each permission below has the
written justification the developer dashboard will ask for. Rule: if a
feature can live without a permission, the permission goes, not the feature.

| Permission | Used by | Justification text (for the dashboard) | Verdict |
|---|---|---|---|
| `storage` | all session/streak/annotation data | "Stores the user's focus sessions, streaks, notes and settings locally on their device." | keep |
| `activeTab` | annotator injection | "Lets the user draw highlights on the page they are currently viewing, only when they click the Annotate button." | keep |
| `identity` | Google sign-in (Docs, Drive per-file, Calendar) | "Lets the user connect their own Google account, through Google's sign-in screen, to read the Google Doc they are working on, create an outline doc, format a doc and add calendar events. Optional." | keep |
| `contextMenus` | "Open PDF in Focus Agent viewer" on PDF links | "Adds a right-click option to open a PDF in the extension's own viewer so it can be highlighted." | keep |
| `idle` | forgotten-timer watchdog | "During a focus session the user started, checks whether the computer is idle so a forgotten timer stops itself. Nothing is recorded or transmitted." | keep |
| `offscreen` | the end-of-sitting chime | "Plays a short sound when a focus timer ends, even if the side panel is closed." | keep |
| Host: `www.googleapis.com`, `docs.googleapis.com`, `docs.google.com` | Google Docs/Drive/Calendar API calls; reading the open Doc | "Used only after the user connects Google, to read/create/format their Google Docs and add calendar events." | keep |
| Optional host: `https://*/*`, `http://*/*` | highlight → annotate/summarize/ask on a page the user picks; screenshots of that tab | "Requested per site, only when the user taps the highlighter or screenshot button on that site. Lets the user highlight the reading and take a screenshot of the visible tab for the coach." | keep — optional, per-site, user-initiated |
| OAuth scopes: `documents`, `drive.file`, `calendar.events` | Google features | "Read/edit Google Docs the user opens with the extension; create files the extension makes (per-file Drive access, not the whole Drive); add calendar events." | keep — `drive.file` replaced full `drive` in v0.8.15 |
| `tabs` | Smart Start tab parking; distraction detection during focus sessions; doc-URL capture | "During a user-started focus session, reads tab URLs to detect visits to distracting sites and offer a coaching reminder. Also organizes tabs when the user starts a work session. URLs are checked locally against a fixed list and never stored or transmitted." | keep — no narrower permission grants URL visibility for the watcher |
| `scripting` | annotator injection (with activeTab) | "Injects the drawing overlay into the current page when the user clicks Annotate." | keep |
| `alarms` | session check-ins, commitment reminders | "Schedules the user's own focus check-ins and reminder notifications." | keep |
| `notifications` | check-ins, receipts, distraction nudges | "Shows the focus reminders and check-ins the user configures." | keep |
| `sidePanel` | the main coach UI | "The extension's main interface lives in Chrome's side panel." | keep |
| Host: `*.myschoolapp.com`, `*.blackbaud.com`, `*.instructure.com`, `classroom.google.com` | portal adapters + coach overlay | "Reads the user's own assignment list from their school portal, on-device, to power prioritization and coaching. Nothing is transmitted off the device." | keep — the core single purpose |
| ~~demo portal~~ removed 2026-09-07 | — | — | (bridge host `127.0.0.1:8000` is dev-only — package-store.sh strips it from the manifest) |

Single-purpose statement (store requires one): "Focus Agent helps a student
start and finish one assignment at a time: it reads their own school portal,
opens what they need, runs a focus clock, and coaches them (explain, check,
quiz) without doing the work for them."

Remote-code policy: compliant — no remote scripts are loaded or executed;
MV3 bundle only. AI responses are data (text), not code.

## Privacy posture (current build, v0.8.15)

- All user data (sessions, streaks, annotations, chat history, practice
  tests, attached-file text, assignment cache, portal snapshot) lives in
  `chrome.storage.local`. No analytics, no telemetry, no accounts.
- **The AI coach client ships in every build.** With no coach code entered
  the extension is in "simple mode" and sends nothing. With a code, coach
  requests (assignment text, grades as numbers, attached text, screenshots,
  chat) go to the coach server → Anthropic and back; the server stores
  nothing beyond a pseudonymous log line. The data-use disclosure in the
  dashboard must say exactly this. PRIVACY.md is written to match.
- The developer's own writing methods are refused server-side for every
  non-developer code and removed from the UI in the friends build
  (`scripts/package-store.sh --friends`).
- **A parent must review PRIVACY.md before submission** (the $5 dev account
  is 18+ too).

## Store listing draft

- **Name:** Focus Agent — check availability at submission; backup names:
  "Focus Agent: Student Focus Coach"
- **Category:** Education (alt: Productivity)
- **Summary (132 chars max):** "Your AI focus coach. Reads your school
  portal, tells you what to start, keeps you off YouTube, and tracks your
  streaks."
- **Description (draft):**
  > Focus Agent turns your school portal into a focus coach.
  >
  > It reads your own assignment list (Blackbaud, Canvas, Google Classroom),
  > figures out what to start first — using YOUR real pace, learned from how
  > you actually work — and coaches you through focus sessions.
  >
  > ▶ Smart Start: one tap opens what you need, parks what you don't, and
  > starts the clock with a checklist ready.
  > ⏱ A clock that stops: 25 means 25, with a chime and a "keep going?"
  > before it ends. Streaks and honest stats.
  > 🧠 A coach that knows the assignment: explain it in plain words, ask
  > about the reading, check a draft for pointers. It never writes for you.
  > 📝 Practice tests and flashcards from your own notes, with Quizlet export.
  > 👀 Drift to YouTube mid-session and your coach negotiates, not blocks.
  > 🖍 Highlight the reading, or screenshot what the highlighter can't reach.
  >
  > Your assignments and sessions stay on your device; coach questions go to
  > the coach and come back, nothing kept. Focus Agent helps you START your
  > work — it never does it for you.
- **Assets needed before submission:** 1280×800 screenshots (first-run
  card, the "start here" list, the work view with the ring clock, a
  practice test), 440×280 promo tile. Screenshot the harness
  (`scripts/harness/panel.html`) with the fixture data.

## Submission checklist (do in order, in the fall)

1. [ ] Fall validation done: Blackbaud field mapping verified, Canvas +
       Classroom tested on real accounts, week-3 retention with classmates
2. [ ] Coach server live (API key server-side, per-user codes) — the AI
       client ships either way; without a code the build is "simple mode"
3. [ ] Parent: reviews PRIVACY.md, registers the $5 dev account
4. [ ] Privacy policy hosted at a public URL (GitHub Pages is fine)
5. [ ] Run `bash scripts/package-store.sh` → install the zip on a fresh Chrome profile and run the core flow
6. [ ] Screenshots + promo tile
7. [ ] Submit as UNLISTED first — install from the store link yourselves,
       verify everything, THEN flip to public
