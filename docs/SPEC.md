# Focus Agent — Product Spec

**This file is the source of truth for what Focus Agent is supposed to do.** Code is built to match it; tests prove the match; every other description (store listing, privacy policy, landing page, parent note) is derived from it. To change the product, change the section here first, then the code, then the test.

Generated from the code at v0.8.16 (2026-09-13), updated for v0.8.17 (2026-09-14: missing/overdue fix, attached links, photo) v0.8.18 (2026-09-15: PDF pages by eye, video summaries) v0.8.19 (2026-09-15: silent coach, whole school year) and v0.8.20 (2026-09-15: overdue grace window, clock race fix); **reviewed by Ben by voice 2026-09-13** — his direction is folded in below and marked 🎯 (decided) or 💬 (to discuss). Each section says what the student does, what happens, what must never happen, and what proves it. Status marks: ✅ proven by an automated test · 👁 checked by hand in the browser harness · ⚠️ implemented but never run for real · ❌ not built.

Ben reviews this and marks what's wrong or not what he wants. Claude and Codex work from the reviewed version.

---

## 0. The product in one paragraph

Focus Agent is a Chrome side panel for a student who wants to do well and can't get started. It reads the student's own school portal, picks the one thing to start, opens what they need, starts a clock with real structure, and puts a coach beside them that knows the assignment. The coach explains, checks and quizzes. It never does the work.

**Audience.** 🎯 Academically inclined **high-school and college** students who want to do well *without cheating*. The pilot starts with Ben and 4–5 friends he sets up in person (Blackbaud at Poly; Canvas, Google Classroom and Aeries at friends' schools); the product is not limited to that age range.

**Three rules that don't move.**
1. Tutor, not ghostwriter. The coach never produces text a student would hand in, never gives the final answer to graded work, and never does an annotation the assignment asked the student to do. Enforced on the coach server for every student code; a developer mode exists only for Ben under a developer code and is never distributed.
2. Portal cookies and passwords never leave the browser. Coach requests carry only what the feature needs, are never stored on the server, and nothing is sent at all without a coach code.
3. 🎯 **Legal everywhere, with schools too.** The product must be legal in every US state and give no school a reason to act against a student for using it: it only reads what the student's own login can already see, never bypasses a school control, never shares a password, and follows each portal's terms as far as a student-side reader can. Any feature that can't meet this is cut, not shipped.

## 1. Reading the school portal

**Promise.** 🎯 Everything the student can see in their portal, the coach can see too: assignments with the teacher's instructions, grades, syllabus/topics, schedule. No typing, no API key: the extension runs inside the student's own logged-in page and asks the portal what the page itself asks.

**What happens.** The student opens their school's assignment page in a tab and taps ↻ (that button reads the portal in the browser; no coach call, no key). A content script calls the portal's own endpoints with the session already logged in, normalizes the result into one assignment shape (`adapters/schema.js`), caches it, and (where the portal exposes it) builds a Student Snapshot: classes, current grades, graded scores, schedule, topics, the personal calendar-feed link. 🎯 **The whole school year is read** (from the portal's own year-start date), finished work included and flagged, so nothing the student can see in the portal is invisible here; for every pending assignment the teacher's ATTACHED links and files are fetched from the assignment's detail endpoint (they are not in the description text).

**Per portal.**
- Blackbaud / myPoly: full read. ✅ field mapping verified on Ben's account. ✅ **v0.8.17:** status code 2 is OVERDUE (was mis-read as "completed", which hid every overdue and missing assignment); `missing_ind` = teacher-marked missing and overrides a "completed" tick; attached links/files come from `/api/assignment2/read/<id>/` (verified live 2026-09-14, 76 items).
- Canvas: assignments, quizzes, instructions via the planner API; a school's own domain via "connect my school". ⚠️ never run on a real account. Grades/schedule ❌ not yet.
- Google Classroom: assignments only today (To-do page scrape). 🎯 **Grades, materials and schedule are required** → ❌ planned: needs the Classroom API (Cloud project, Classroom scopes, the school allow-listing the app for under-18 accounts). Section 13 covers the Google side.
- Aeries: ❌ not built. Plan: a DevTools session on a friend's Student Portal login, then an adapter on the same pattern. What that gives us: read access to everything *that student* can see (assignments, grades, schedule), from inside their logged-in page; not access to anything beyond their own account.
- Unsupported systems: named, with "connect my school" and a debug-info button. 👁

**Must never.** Ask for or store a password. Send cookies anywhere. Fetch from a page the student didn't open. Read anything the student couldn't see themselves.

**Proven by.** Adapter fixtures: ❌ none yet (gap).

## 2. First run

**Promise.** A student who installs from a link knows what to do in ten seconds.

**What happens.** With nothing connected, the list shows one card: 1) open your school's assignment page, 2) tap ↻ Refresh (the real button, inline), 3) tap ▶ Smart Start at the top. "Different school or not working?" folds open to connect-my-school and the last diagnostic. The popup says the same in two lines. 👁 🎯 Ben likes it; subject to change after the first real tests (other school systems can't be tested until their adapters exist).

**Must never.** Show developer diagnostics or jargon as the first thing a student reads.

## 3. The list (today)

**Promise.** The student sees what to start, not a to-do list.

**What happens.** Assignments are ranked by urgency (teacher-marked MISSING first, then overdue, then due-soon, size, points, and the student's own pace history). 🎯 **Missing and overdue work is pinned in its own red section at the top of the list** ("⚠️ N missing / overdue — clear these first"), each card badged MISSING or OVERDUE with the date it was due; the coach's pick never looks past that section (✅ v0.8.17, smoke test). 🎯 **Overdue grace window (v0.8.20).** Blackbaud calls anything past due that the student never ticked "complete" OVERDUE, forever — and most of those are done (readings, in-class work, paper hand-ins nobody ticks). So past-due work counts as overdue for **5 days** after the due date; after that it's *stale*: out of the ranking, folded away at the bottom with an honest label ("past due · never ticked complete"), and it comes back on top the moment the teacher marks it MISSING — the portal's real signal. ✅ smoke test. The coach's pick sits at the top as a "start here" card with one full-width ▶ Smart Start and the reason in one sentence; the rules pick appears instantly and the coach upgrades it in place. Below: a 7-day forecast strip, "tonight I have" time chips (all/30m/1h/1.5h/2h) that reorder the list to fit and say what doesn't fit, an "noticed something" card when an assignment has been visible for days with zero sessions, then every assignment as a card with its own ▶ and a ✓ for "already done". A running clock shows as a resume banner. 👁

🎯 **Everything else the portal has this year** — completed, graded, or ticked done here — sits folded at the bottom as "✓ finished this year (N)", each row with course, date, status and a tap to open it in the portal. It never competes with pending work (✅ v0.8.19, smoke test).

**Must never.** Bury the primary action below the fold at the panel's minimum width. Call something overdue for weeks on the strength of a checkbox the teacher never asked for.

**Proven by.** `scripts/smoke-panel.js`: missing section pinned, MISSING first, OVERDUE badged, hero = the missing one (✅). `lib/priority.js` ranking beyond that: ❌ no unit test (gap).

## 4. Smart Start

**Promise.** One tap and the student is working: the right tab open, a checklist ready, the clock running, the coach already talking.

**What happens.** Smart Start opens the assignment and **every link the assignment itself carries** (the teacher's attached files and links first, then links in the instructions, up to 8 — always, whatever the plan says; ✅ smoke test) plus the plan's chosen resources in tabs, parks distracting tabs in a minimized window, proposes the sitting length from the student's own history (5–25 min), starts the clock, and switches to the work view. If Google is connected and the assignment wants a document, it creates a new outline doc. The coach's first message says what it set up and the first move; it asks one clarifying question only when the instructions are missing. Starting a second assignment ends the running sitting. 👁 core flow; ⚠️ tab parking and doc creation not re-tested since v0.8.

🎯 **Google must actually work for friends before Wednesday's tests**: the sign-in on a school-managed account, the extension-ID/OAuth problem (section 13), and a real outline-doc creation on a second machine.

**Must never.** Start writing content into any document. Open URLs that aren't on the assignment's own resource list.

## 5. The focus clock

**Promise.** The clock has structure the student can't talk their way out of. 25 means 25; the break is a break; the log never lies.

**What happens today.** The ring fills over the planned minutes. At the planned end: one chime, the ring goes amber, and one card asks "keep going?" with +5 / +10 / done ✓ / stop and a visible 45-second countdown. No answer → the clock stops at the planned end and logs exactly the planned minutes. A chip below the time already worked ends at the next whole minute and logs the real time. Every minute the worker checks for signs of life; ten quiet minutes → "still there?"; five more → the clock stops at the last sign of life; quiet minutes are logged separately. Alarms survive an extension reload or Chrome restart. Paper mode keeps the same hard stop.

🎯 **Planned (next):** a work/break cadence — 15 minutes of work, then a **5-minute break** the app runs itself. The break is set in stone: the timer counts it down, the student can't extend it or skip the structure, and work resumes on its own. The cadence is the object, not a suggestion. ❌ not built; design in the next brief (lengths configurable? default 15/5; how "stiff" the resume is).

💬 **To discuss with Ben and his dad:** blocking social media (YouTube, TikTok, Instagram) while the work clock runs, instead of only negotiating. Not decided. Considerations: it's the one thing every abandoned tool did; Chrome can block with `declarativeNetRequest` or by redirecting the tab; students defeat blocks on the laptop by switching to the phone; the break window could be where those sites are allowed. Test it, don't assume.

**Must never.** Log more minutes than the student sat. Keep running after the planned end without an answer. Chime twice. Lose its watchdog after a restart. Let a break be extended into the work block.

**Proven by.** `scripts/test-background.js` ✅ (14 cases). Panel countdown 👁. ⚠️ real chime, real 45 s stop and a mid-sitting reload not yet run in the actual extension.

## 6. The checklist

**Promise.** The assignment is broken into steps a student can start in five minutes, based on what the assignment actually says, not what its title suggests.

**What happens.** 🎯 The checklist is built **after** the resources are opened and the instructions are read: the coach uses the real instruction text, the attached reading and the teacher's linked pages, and does not assume from the type alone. Until that's available, a short placeholder (open the assignment, read the instructions) stands in; the real checklist replaces it without touching steps the student checked or wrote. Each step has an estimate; ⋯ offers smaller / why / move / remove; the student can add steps. Checklists are always the student's to change. ✅ fallback no longer empties the list; 👁 UI. ❌ the "read everything first, then build" ordering is only partly true today (the rules version is type-based) — next brief.

**Must never.** Delete a student's own or completed steps. Show an empty checklist. Present a guessed checklist as if it read the instructions.

## 7. The coach (chat)

**Promise.** A coach that knows this assignment, the student's files, their grades and their week, and helps like a sharp older friend — with one suggestion at a time, not a wall of buttons.

**What happens.** In the work view the chat is scoped to the assignment: it sees the assignment, the checklist, attached files with highlights, the open Google Doc's text, the snapshot (grades as numbers, schedule), session stats and the conversation. Replies are plain text.

🎯 **The coach only talks when spoken to (decided 2026-09-15, ✅ v0.8.19).** Every message that isn't an answer to something the student just did — the Smart Start setup note, tips, the video offer, "before we go" questions, "every step is checked, turned in?" check-ins, "learned from your doc" — is dropped. The one exception is the time-up bubble, which is the clock's control (+5 / +10 / done / stop). ⚙ → "coach can speak up on its own" turns the extras back on; it is off by default for everyone.

🎯 **Planned: one bubble, not nineteen chips.** The coach offers the single most useful next thing as one bubble that disappears when used and is replaced by the next: *explain this* → *break it down* → *make me a practice quiz* (or *check my draft* for writing, *quiz me* for tests), in an order that follows the work. Everything else stays reachable by typing. The current chip row (I'm stuck / explain / check my draft / practice test / ⋯ nine more) is the thing to replace. ❌ not built; design in the next brief.

**Help policy (tutor mode, every student).** Explain all the way, work a parallel example, check reasoning, point at the exact mistake. Hold back only the final answer to a graded question or sentences they'd paste in as their own, say so in one casual line, and immediately give the next most useful thing. Never lecture.

**Simple mode.** With no coach code, or the coach unreachable, the panel says so in plain words; the checklist, clock and streaks keep working; chat returns a short honest line. Never a developer instruction.

**Must never.** Write into a document for a student. Apply model-authored edits. Use the student's writing-voice profile. Expose developer or answer mode to a student code, whatever the client sends.

**Proven by.** `scripts/security_tests.py` ✅; `scripts/test-panel-boundary.js` ✅. ⚠️ actual model replies on real inputs not evaluated yet (no API key).

## 8. Explain

**Promise.** The teacher's instructions in plain words: what they want, the traps, the first move, an honest time estimate. Rules version works offline. ✅ fallback no longer prints "undefined".

## 9. Check my draft

**Promise.** Tutor feedback on a draft the student pastes or has open: a grade estimate labelled as a guess, strengths, issues quoted from the draft with a hint each, missing requirements, next step. Pointers, never rewrites. Simple mode says it can't really grade. 👁

## 10. Highlight → annotate · summarize · ask

**Promise.** On any reading the student opens, select text and get three bubbles: 🖍 annotate (the coach pre-fills a *question* about the passage; the student writes the note), ≡ summarize, ? ask. Highlights anchor to text, survive reload, and feed the coach and practice tests. PDFs (including Drive PDFs) reopen in the extension's own viewer. Works on sites the student granted, per site, on tap.

🎯 **The annotation rule (decided).** The coach knows the assignment, so it decides per assignment: if the assignment *requires* annotations (annotate this chapter, mark up this passage, reading notes are graded), then annotation help, summaries and "what to highlight" are off for that reading — doing them is the assignment. If annotations are *not* what's being graded, annotating and summarizing are fine, any time. The coach says which case applies in one line. ✅ **built for 📸/📷 in v0.8.17** (server-side, from the assignment's own words; unknown assignment = treated as graded; `security_tests.py`). ❌ the text highlighter's ≡ summarize is still always on.

**Must never.** Run on a site the student didn't grant. Fire on hover. Do a graded annotation for the student.

**Status.** ⚠️ toolbar last verified in v0.8; viewer never run from a packaged build.

## 11. 📸 Annotate my screen · 📷 Photo of my page

**Promise.** Anything the highlighter can't reach (Google Docs, Drive previews, images, scans): screenshot the tab, drag a region, and the coach helps the student read it. **Or upload a photo** of what's in front of them — a textbook page, a worksheet, their own handwritten notes — via the 📷 chip, by pasting an image into the chat box, or by dropping one on the work view (v0.8.17).

**What happens.** Follows the annotation rule in section 10. When the assignment is not a graded annotation: what the page is, what to look for while reading, and 🎯 **as many questions as the page deserves** (not capped at 2–3; a dense page can get eight), plus key ideas and quotes worth highlighting. When it is a graded annotation: orientation and questions only, and the coach says why. With a question typed first, it answers about what's visible under the tutor policy. The transcribed text joins the assignment's files. Only a small thumbnail is kept. ✅ v0.8.17: assignment-aware (section 10 rule) with a 2–4 sentence summary, key ideas, quotes with a why, and up to 10 questions when annotating isn't graded; orientation + why + up to 8 questions when it is; the photo prompt knows it's a photo and reads handwriting. ⚠️ never run against the real model yet.

**Must never.** Capture anything without a tap. Author a graded annotation.

**Proven by.** `security_tests.py` ✅ (student vs developer prompts). ⚠️ `captureVisibleTab` and the permission prompt never run in the real extension.

### 11.1 👁 PDF pages the coach reads by eye (v0.8.18)

**Promise.** 🎯 A PDF with scans, diagrams, graphs, equations or handwriting is understood, not just its text layer. "No text found (scanned PDF?)" stops being an answer.

**What happens.** When a PDF is attached (a teacher's Drive file, a link in the assignment, a local upload), the text layer is extracted as before. Every page with (almost) no text — under ~150 characters: a scan, a figure-only page, a worksheet — is rendered by pdf.js to a JPEG inside the extension and sent to the coach one page at a time (`readPage`). The coach transcribes what's on the page (handwriting too) and describes each figure, diagram, graph or equation in a sentence or two. That text joins the file, so summaries, practice tests, flashcards and 📸 questions can use it. The file chip shows 👁 with a page count while it reads and afterwards. Cap: 10 image-only pages per PDF (one coach call each); more are named in the chip's tooltip and can be sent as 📷 photos.

**Must never.** Send pages that already have a text layer. Run without the smarter coach (simple mode keeps the old text-only path). Store the page images — only the transcription is kept.

**Proven by.** `security_tests.py` (readPage needs an image; student prompt = transcription + figure description, never analysis). ⚠️ never run against the real model or a real scanned PDF.

## 12. Practice test · quiz me · flashcards · study plan

**Promise.** Studying tools built from the student's own material. 🎯 Ben will revise these after the first real feedback; current behavior stands until then.

- Practice test: multiple choice, true/false, short answer (and flashcards) from attached files and highlights; graded in the thread; near-miss short answers self-marked; retake misses; more like the misses; harder; ✎ edit or delete any question; + my own; copy for Quizlet with an open-Quizlet button. Persists per assignment. 👁; ⚠️ live call verified once.
- Quiz me: one question at a time in chat with honest ✓/✗ and a running score.
- Flashcards: from files and highlights, tap to flip, copy for Quizlet.
- Study plan: one session per day until the test, added to the checklist.

**Must never.** Be the assessed work itself.

### 12.1 🎬 Summarize the video (v0.8.18)

**Promise.** 🎯 A video the assignment points at (or the YouTube tab the student is on) gets a summary and timestamped key moments the student can jump to, without leaving the assignment.

**What happens.** Tap 🎬 (or the coach's offer after Smart Start opens a YouTube link). The extension reads the video's caption track from the open YouTube tab — no API key, no download — prefers human captions over auto-captions, and hands the coach the captions with timestamps plus the assignment. The annotation rule (section 10) applies: when taking notes on the video *is* the graded work ("notes on video"), the student gets what the video is about, why the coach won't summarize it, what to listen for, moments worth pausing at (timestamps only), and questions to be able to answer. Otherwise: a summary in plain words, key moments with timestamps (tap one → the video seeks there), terms worth knowing, questions. A question typed first is answered from the captions. Captions carry only what is *said*: a whiteboard, an equation on screen, a chart or a silent demo is invisible to them, and the coach says so. **With frames on** (⚙ → "video: also look at the picture"), the extension seeks the video to 8 evenly spaced moments, screenshots each (the tab must be visible for ~8 s), and sends the frames with the captions, so what was *shown* is described too. More coach calls, so it is a toggle, off by default. No captions (a private Drive video, VoiceThread, an upload with CC off) → the coach says it can't hear it and points at 📸 / frames.

**Also.** Smart Start no longer parks a tab the assignment itself links to (YouTube was on the distractor list, so the "notes on video" tab used to get parked), and the drift nudge skips those hosts for the session.

**Must never.** Download or store video or audio. Summarize a video whose notes are the graded work. Seek the student's video without the frames toggle on.

**Proven by.** `security_tests.py` (student "notes on video" → orientation, no summary; problem-set video → summary allowed; frames = images validated like any image). ⚠️ never run on a real YouTube tab; caption endpoint behavior can change without notice (fallback: the coach says captions weren't readable).

## 13. Google

**Promise.** 🎯 Connect once and Focus Agent works with the Google products students actually use for school: Docs today; Classroom (grades, materials, schedule), Slides and Sheets reading, Drive files and Calendar as the pilot needs them; Gemini only if a school's setup makes it the right model to route through. The direction is "most Google products, all if needed", added one at a time as a real student needs it.

**What happens today.** "connect G" goes through Google's own sign-in (Chrome account, or a personal Gmail chooser when the school blocks third-party apps). Scopes: Docs read/write, Drive per-file, Calendar events. The coach reads the open Doc; Smart Start can create an outline doc; "format my doc" applies MLA styling and names the doc with a link; calendar blocks are optional. Disconnect any time.

🎯 **Must be solved before friends test (the "OAuth drama"):** (a) school-managed accounts that block third-party sign-in → the personal-Gmail door must work on a friend's machine; (b) the extension ID changes per unpacked install, which breaks the registered redirect → add a manifest `key` and update the Google OAuth clients to the new ID; (c) Classroom API access for under-18 accounts needs the school to allow-list the app → find out at the first Classroom friend's school.

**Must never.** Change a student's words. Write model-authored content for a student. Open a sign-in window on its own from the background.

**Proven by.** `test-panel-boundary.js` ✅; `test-background.js` ✅; `test-docops.js` ✅. ⚠️ real OAuth on a second machine never tested.

## 14. Distraction watcher

**Promise.** Drift to YouTube mid-sitting and the coach notices.

**What happens today.** During a session the worker checks the active tab's hostname against a fixed list; a nudge says how much is left at the student's pace; at most one per two minutes; logged as a distraction for the student's own stats. Off when no session runs. ⚠️ not re-tested recently.

💬 **Open (see section 5):** negotiate vs block during the work block. Until decided, the watcher negotiates.

**Must never.** Log sites outside a session. Send hostnames anywhere.

## 15. Done

**Promise.** 🎯 Finishing an assignment should feel like something. Way more than it does now.

**What happens today.** Done ✓ (or the portal flipping the assignment to complete, or every step checked) ends the sitting, shows minutes vs the student's guess, a one-line debrief, per-course estimate calibration once enough data exists, and the next pick with its own ▶. A timed-out or idle stop is a stop, not a completion. 👁; ✅ pendingDone reason.

❌ **Planned:** a real finish moment — a full-screen beat, the streak, what got knocked out, one line from the coach that lands — designed in a later brief once the first testers say what "finished" feels like to them.

## 16. Stats ("you")

Day streak, hours this week, sessions, focused minutes over 14 days, when you actually focus, distraction cost, commitments. 🎯 Ben's view: students don't care much about stats and know themselves better than a chart does; keep this small, honest and out of the way. Nothing here is a priority. 👁 renders with empty data.

## 17. Classes

🎯 The app knows the student's classes on its own: classes with current grade and trend, this week's schedule, syllabus/topics, everything the portal shows the student, for every supported portal. Blackbaud only today; Canvas and Classroom grades/schedule are gaps (sections 1 and 13). Phone notifications by adding the portal's private calendar feed to the student's calendar. ⚠️ the feed link's privacy is explained nowhere in the UI yet.

## 18. Settings

Your school (connect my school, copy debug info) · coach link + code with a one-line explanation (leave blank = simple mode) · Google connect · draw on this page. Developer controls exist only on Ben's build. 👁

## 19. The coach server

**Promise.** One small server that holds the AI key, decides who is a developer, and forwards requests without keeping them.

**Guarantees.** Every request needs an access code (or is the developer's own open loopback bridge). Codes are per person and revocable; a code marked `dev` is the only developer. Students are forced to tutor mode before any prompt is built; writing methods are refused with 403 before any model call; the voice profile is dropped; 📸 is orientation-only. Only `chrome-extension://` origins may call it. Body size is capped; images must decode; malformed requests get fixed 4xx sentences. Clients only ever see fixed error sentences; logs carry a pseudonymous id, the method name and an error class, never request text. A hosted server refuses to start without the API engine. Daily call cap per code (in memory; resets on restart, by decision). A mock engine exists for tests.

**Proven by.** `scripts/security_tests.py` ✅ 75 cases. ⚠️ never deployed off Ben's Mac; HTTPS/proxy/cold-start behavior untested; no API key yet.

## 20. Developer mode

Ben's only, under a developer code, never distributed: refused server-side for every other code and absent from the friends build's UI. ✅ That's the whole section.

## 21. How the app gets to a friend (in plain words)

There are two copies of Focus Agent. The **dev checkout** is the folder Ben works in, loaded into Chrome from that folder. The **build** is a zip made from it by `npm run package:friends`: same code, minus the developer controls and minus anything only Ben needs. A friend unzips it and loads it into Chrome from that folder ("load unpacked") until there's a store listing to install from. Before every build, `npm test` runs the four test suites; the build script checks that every file the code needs is inside and prints a fingerprint of the zip. ⚠️ No zip has been installed on a fresh Chrome profile yet; that's Ben's next test. Store distribution is later and not a concern now.

## 22. Data: stored, sent, never

**On the device (🎯 keep everything useful; nothing compromising).** Sessions, streaks, per-assignment notes/checklists/chat/tests/attached text/thumbnails, highlights, assignment cache, snapshot (grades, schedule, topics), settings, a short-lived Google token. Finished assignments lose chat/files/tests after 30 days. Storage-full shows a notice. To revisit later.

**Sent to the coach, only on a coach action, only with a code.** Assignment title/instructions/due, courses and grades as numbers, schedule times, attached text and highlights, the screenshot, the message and recent conversation, session stats.

**Never, anywhere.** Cookies, passwords, name, student id, email, teacher contact details, the calendar link.

PRIVACY.md, PARENTS.md, STORE.md and the site are written from this section.

## 23. Known gaps (honest list)

**From Ben's 2026-09-13 review, now planned (next briefs, in this order):** Google OAuth working on a friend's machine (13) · work/break cadence (5) · one-bubble coach (7) · assignment-aware annotation rule for summarize + 📸, more 📸 questions (10, 11) · checklist built after reading (6) · Classroom grades/materials/schedule (1, 13) · a real finish moment (15). **To discuss:** blocking social media during work (5, 14), with Ben's dad.

- Aeries adapter ❌; Canvas and Classroom ⚠️ never on a real account; Classroom has no grades/materials/schedule.
- No adapter fixtures, no ranking unit tests, no automated core-flow test beyond a jsdom boot.
- Real-extension checks pending: chime, 45 s stop, mid-sitting reload, 📸, 📷 photo (paste/drop too), 👁 a real scanned PDF, 🎬 a real YouTube tab (captions + frames), the missing/overdue section on Ben's real feed (~19 overdue + 2 missing expected 2026-09-14), attached links opening on a real assignment, fresh-profile install, second-machine Google.
- Hosted coach server: not deployed; API key pending; always-on vs auto-stop undecided.
- Manifest `key` (stable extension ID) undecided because it changes the ID and the Google OAuth clients must follow.
- Summarize on readings vs the annotation policy: decided (§10) and built for 📸/📷; the text highlighter's ≡ summarize is still unconditional.
- Accessibility (labels, focus rings, live regions): not done; needed before the store, not the pilot.
- Placeholders: contact email, policy date, install link.
