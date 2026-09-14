# Focus Agent — Product Spec

**This file is the source of truth for what Focus Agent is supposed to do.** Code is built to match it; tests prove the match; every other description (store listing, privacy policy, landing page, parent note) is derived from it. To change the product, change the section here first, then the code, then the test.

Generated from the code at v0.8.16 (2026-09-13). Each section says what the student does, what happens, what must never happen, and what proves it. Status marks: ✅ proven by an automated test · 👁 checked by hand in the browser harness · ⚠️ implemented but never run for real · ❌ not built.

Ben reviews this and marks what's wrong or not what he wants. Claude and Codex work from the reviewed version.

---

## 0. The product in one paragraph

Focus Agent is a Chrome side panel for a high-school student who wants to do well but can't get started. It reads the student's own school portal, picks the one thing to start, opens what they need, starts a clock that actually stops, and puts a coach beside them that knows the assignment. The coach explains, checks and quizzes. It never does the work.

**Audience.** Academically inclined 14–16-year-olds who procrastinate at the *start* moment. First users: Ben, then 4–5 friends he sets up in person (Blackbaud at Poly; Canvas, Google Classroom and Aeries at friends' schools).

**Two rules that don't move.**
1. Tutor, not ghostwriter. The coach never produces text a student would hand in, never gives the final answer to graded work, and never annotates a reading for them. Enforced on the coach server for every student code; a developer mode exists only for Ben under a developer code.
2. Portal cookies and passwords never leave the browser. Coach requests carry only what the feature needs, are never stored on the server, and nothing is sent at all without a coach code.

---

## 1. Reading the school portal

**Promise.** The student's real assignment list, with due dates and the teacher's instructions, appears in the panel without typing anything in.

**What happens.** The student opens their school's assignment page in a tab and taps ↻. A content script on that page calls the portal's own endpoints with the session already logged in, normalizes the result into one assignment shape (`adapters/schema.js`), and caches it so the panel works away from the tab. On Blackbaud the same read also builds a Student Snapshot: classes, current grades, graded scores, schedule for the week, teacher-posted topics, and the personal calendar-feed link. Overdue work from the last 14 days is included.

**Per portal.**
- Blackbaud / myPoly: full read (assignments with instructions, snapshot). ✅ field mapping verified on Ben's real account; 👁 overdue fix.
- Canvas: assignments, quizzes and instructions via the planner API, on `*.instructure.com` or a school's own domain through "connect my school". ⚠️ never run on a real account.
- Google Classroom: assignments only (title, course, due, link) scraped from the To-do page; no grades, materials or schedule. Ids are stable across refreshes. ⚠️ never run on a real account.
- Aeries: ❌ not built. Plan: a DevTools session on a friend's Student Portal login, then an adapter on the same pattern.
- Unsupported systems: named, with a "connect my school" path and a debug-info button. 👁

**Must never.** Ask for or store a password. Send cookies anywhere. Fetch from a page the student didn't open.

**Proven by.** Adapter fixtures: ❌ none yet (gap).

## 2. First run

**Promise.** A student who installs from a link knows what to do in ten seconds.

**What happens.** With nothing connected, the list shows one card: 1) open your school's assignment page (buttons for Classroom; Blackbaud/Canvas by name), 2) tap ↻ Refresh (the real button, inline), 3) tap ▶ Smart Start at the top. "Different school or not working?" folds open to the connect-my-school button and the last diagnostic. The popup says the same in two lines. 👁

**Must never.** Show developer diagnostics or jargon ("cached assignments", "portal tabs", "bridge") as the first thing a student reads.

## 3. The list (today)

**Promise.** The student sees what to start, not a to-do list.

**What happens.** Assignments are ranked by urgency (overdue first, then due-soon, size, points, and the student's own pace history). The coach's pick sits at the top as a "start here" card with one full-width ▶ Smart Start and the reason in one sentence; the rules pick appears instantly and the coach upgrades it in place. Below: a 7-day forecast strip, "tonight I have" time chips (all/30m/1h/1.5h/2h) that reorder the list to fit and say what doesn't fit, an "noticed something" card when an assignment has been visible for days with zero sessions, then every assignment as a card with its own ▶ and a ✓ for "already done". A running clock shows as a resume banner. 👁

**Must never.** Bury the primary action below the fold at the panel's minimum width.

**Proven by.** `lib/priority.js` ranking: ❌ no unit test (gap).

## 4. Smart Start

**Promise.** One tap and the student is working: the right tab open, a checklist ready, the clock running, the coach already talking.

**What happens.** Smart Start opens the assignment and its linked resources in tabs, parks distracting tabs in a minimized window, proposes the sitting length from the student's own history (Ramp: 5–25 min), starts the clock, and switches to the work view with a checklist. If Google is connected and the assignment wants a document, it creates a new outline doc from the checklist. The coach's first message says what it set up and the first move; it asks one clarifying question only when the instructions are missing. Starting a second assignment ends the running sitting. 👁 core flow; ⚠️ tab parking and doc creation not re-tested since v0.8.

**Must never.** Start writing content into any document. Open URLs that aren't on the assignment's own resource list.

## 5. The focus clock

**Promise.** 25 means 25. The clock never runs away and never lies in the log.

**What happens.** The ring fills over the planned minutes. At the planned end: one chime (from the panel, or from the extension's offscreen page when the panel is closed, never both), the ring goes amber, and one card asks "keep going?" with +5 / +10 / done ✓ / stop and a visible 45-second countdown. No answer → the clock stops *at the planned end* and logs exactly the planned minutes; the done view opens (or a notification says so). Chunk chips can extend or shorten the sitting; a chip below the time already worked ends at the next whole minute and logs the real elapsed time. Every minute the worker checks for signs of life; ten quiet minutes → "still there?"; five more → the clock stops at the last sign of life and the quiet minutes are logged separately, never counted. If the extension reloads or Chrome restarts mid-sitting, the alarms are re-armed. Paper mode (no doc, no tab activity in the first sitting) keeps the same hard stop.

**Must never.** Log more minutes than the student sat. Keep running after the planned end without an answer. Chime twice. Lose its watchdog after a restart.

**Proven by.** `scripts/test-background.js` ✅ (14 cases: re-arm on startup/install, one-shot alarm, single chime, 45 s stop logs planned minutes, extend, panel/worker race). Panel countdown 👁 in the harness. ⚠️ the real chime, the real 45 s stop and a mid-sitting reload have not been run in the actual extension.

## 6. The checklist

**Promise.** The assignment is already broken into steps a student can start in five minutes.

**What happens.** Rules produce a checklist instantly from the assignment type; the coach replaces it with a better one from the real instructions when available (never replacing steps the student checked or wrote). Each step has an estimate and a "deliverable" line; ⋯ on a step offers smaller / why / move / remove; the student can add steps. Progress shows on the list card. If the coach call fails, the rules checklist stays (it used to be wiped; fixed v0.8.12). ✅ fallback; 👁 UI.

**Must never.** Delete a student's own or completed steps. Show an empty checklist.

## 7. The coach (chat)

**Promise.** A coach that knows this assignment, the student's files, their grades and their week, and helps like a sharp older friend.

**What happens.** In the work view the chat is scoped to the assignment: it sees the assignment, the checklist, attached files with the student's highlights, the open Google Doc's text, the snapshot (grades as numbers, schedule), session stats and the conversation. Chips: I'm stuck, explain, check my draft, practice test (on tests), and behind ⋯: quiz me, break it down, 5 more minutes, format my doc, flashcards, study plan, 📸 annotate my screen, clear chat. A second, general chat lives in the "coach" tab (what's due, why this first, replan my week). Replies are plain text.

**Help policy (tutor mode, every student).** Explain all the way, work a parallel example, check reasoning, point at the exact mistake. Hold back only the final answer to a graded question or sentences they'd paste in as their own, say so in one casual line, and immediately give the next most useful thing. Never lecture.

**Simple mode.** With no coach code, or the coach unreachable, the panel says so in plain words ("simple mode"), the checklist, clock and streaks keep working, and chat returns a short honest line. Never a developer instruction.

**Must never.** Write into a document for a student. Apply model-authored edits. Use the student's writing-voice profile. Expose developer or answer mode to a student code, whatever the client sends.

**Proven by.** `scripts/security_tests.py` ✅ (student flags forced to tutor, no docops offered, no voice, writing methods refused with zero model calls); `scripts/test-panel-boundary.js` ✅ (no doc/calendar side effects for any non-developer state). ⚠️ actual model replies on real inputs not evaluated yet (no API key).

## 8. Explain

**Promise.** The teacher's instructions in plain words: what they want, the traps, the first move, an honest time estimate. Rules version works offline. ✅ fallback no longer prints "undefined".

## 9. Check my draft

**Promise.** Tutor feedback on a draft the student pastes or has open: a grade estimate labelled as a guess, strengths, issues quoted from the draft with a hint each, missing requirements, next step. Pointers, never rewrites. Simple mode says it can't really grade. 👁

## 10. Highlight → annotate · summarize · ask

**Promise.** On any reading the student opens, select text and get three bubbles: 🖍 annotate (the coach pre-fills a *question* about the passage; the student writes the note), ≡ summarize (Chrome's on-device model first, the coach second), ? ask. Highlights anchor to text and survive reload; they feed the coach and practice tests. PDFs reopen in the extension's own viewer with a text layer; Drive PDFs too. Works on sites the student granted, per site, on tap.

**Open question for Ben.** Summarize on a reading assignment hands over a summary. The 2026-09-12 decision was "the coach reacts to annotations, never authors them"; summarize hasn't been changed to match yet.

**Must never.** Run on a site the student didn't grant. Fire on hover.

**Status.** ⚠️ toolbar last verified in v0.8; viewer never run from a packaged build.

## 11. 📸 Annotate my screen

**Promise.** Anything the highlighter can't reach (Google Docs, Drive previews, images, scans): screenshot the tab, drag a region, and the coach orients the student.

**What happens.** For a student code the coach returns what the page is, what to look for while reading, and 2–3 questions to be able to answer afterwards. No key ideas, no quotes worth highlighting, no summary of the argument. With a question typed first, it answers about what's visible under the tutor policy. The transcribed text joins the assignment's files. Only a small thumbnail is kept. Developer code: full overview.

**Must never.** Capture anything without a tap. Author the annotations for a student.

**Proven by.** `security_tests.py` ✅ (student prompt asks for orientation only; developer gets the overview). ⚠️ `captureVisibleTab` and the permission prompt never run in the real extension.

## 12. Practice test · quiz me · flashcards · study plan

**Promise.** Studying tools built from the student's own material.

- Practice test: multiple choice, true/false, short answer (and flashcards) generated from attached files and highlights; graded in the thread; near-miss short answers self-marked; retake misses; more like the misses; harder; ✎ edit or delete any question; + my own; copy for Quizlet (term ⇥ answer) with an open-Quizlet button. Tests persist per assignment across cleared chats. 👁 built and graded in the harness; ⚠️ live bridge call verified once.
- Quiz me: one question at a time in chat with honest ✓/✗ and a running score.
- Flashcards: from files and highlights, tap to flip, copy for Quizlet.
- Study plan: one session per day until the test, added to the checklist.

**Must never.** Be the assessed work itself (a test is self-testing, not the assignment).

## 13. Google (optional)

**Promise.** Connect once and the coach can read the doc you're working on, start an outline doc, and format a doc without touching your words.

**What happens.** "connect G" goes through Google's own sign-in (Chrome account or a personal Gmail chooser when the school blocks third-party apps). Scopes: Docs read/write, Drive per-file (only files the extension creates or opens), Calendar events. Reading the open Doc feeds the coach; Smart Start can create an outline doc; "format my doc" applies MLA styling and names the doc with a link; calendar blocks are optional. Disconnect any time.

**Must never.** Change a student's words. Write model-authored content for a student. Open a sign-in window on its own from the background.

**Proven by.** `test-panel-boundary.js` ✅ (format runs for students; edits blocked); `test-background.js` ✅ (worker non-interactive); `test-docops.js` ✅ index math. ⚠️ real OAuth on a second machine never tested; the extension ID changes per unpacked install until a manifest `key` is added (decision pending).

## 14. Distraction watcher

**Promise.** Drift to YouTube mid-sitting and the coach negotiates; it never blocks.

**What happens.** During a session the worker checks the active tab's hostname against a fixed list; a nudge notification says how much is left at the student's pace; at most one per two minutes; each is logged as a distraction event for the student's own stats. Off when no session runs. ⚠️ not re-tested recently.

**Must never.** Block or close a tab. Log sites outside a session. Send hostnames anywhere.

## 15. Done

**Promise.** Finishing feels finished.

**What happens.** Done ✓ (or the portal flipping the assignment to complete, or every step checked) ends the sitting, shows minutes vs the student's guess, a one-line debrief, per-course estimate calibration once enough data exists, and the next pick with its own ▶. A timed-out or idle stop is a stop, not a completion. 👁; ✅ pendingDone reason.

## 16. Stats ("you")

Day streak, hours this week, total sessions, level/XP, focused minutes over 14 days, when you actually focus, distraction cost, commitments with receipts, a "procrastination autopsy" (rules insights, coach insights when available). Honest numbers only; no comparison to other students. 👁 renders with empty data. ⚠️ insight quality unverified.

## 17. Classes

Classes with current grade and trend, this week's schedule, and phone notifications by adding the portal's private calendar feed to the student's calendar. Blackbaud only today. ⚠️ the feed link's privacy is explained nowhere in the UI yet.

## 18. Settings

Your school (connect my school, copy debug info) · coach link + code with a one-line explanation (leave blank = simple mode) · Google connect · writing voice (developer only) · developer mode (visible only when the server granted the developer role) · draw on this page. 👁

## 19. The coach server

**Promise.** One small server that holds the AI key, decides who is a developer, and forwards requests without keeping them.

**Guarantees.** Every request needs an access code (or is the developer's own open loopback bridge). Codes are per person and revocable; a code marked `dev` is the only developer. Students are forced to tutor mode before any prompt is built; writing methods are refused with 403 before any model call; the voice profile is dropped; 📸 is orientation-only. Only `chrome-extension://` origins may call it. Body size is capped; images must decode; malformed requests get fixed 4xx sentences. Clients only ever see fixed error sentences; logs carry a pseudonymous id, the method name and an error class, never request text. A hosted server refuses to start without the API engine. Daily call cap per code (in memory; resets on restart, by decision). A mock engine exists for tests.

**Proven by.** `scripts/security_tests.py` ✅ 75 cases. ⚠️ never deployed off Ben's Mac; HTTPS/proxy/cold-start behavior untested; no API key yet.

## 20. Developer mode (Ben only)

Under a developer code: answer mode, write this step, answer these, edit my doc, autopilot, photo of my work, mark complete (not wired), nightly plan, writing-voice import. Removed from the friends build's UI entirely and refused server-side for every other code. ✅ both.

## 21. Builds and distribution

`npm test` runs four suites. `npm run package` builds the store zip; `npm run package:friends` builds the pilot zip with `build.json` (developer UI removed at boot). Both include the PDF viewer and the chime page; the script verifies every referenced path exists and prints a SHA-256. Friends install the zip unpacked until there's a store listing. ⚠️ no zip has been installed on a fresh profile yet.

## 22. Data: stored, sent, never

**On the device.** Sessions, streaks, per-assignment notes/checklists/chat/tests/attached text/thumbnails, highlights, assignment cache, snapshot, settings, a short-lived Google token. Finished assignments lose chat/files/tests after 30 days. Storage-full shows a notice.

**Sent to the coach, only on a coach action, only with a code.** Assignment title/instructions/due, courses and grades as numbers, schedule times, attached text and highlights, the screenshot, the message and recent conversation, session stats.

**Never.** Name, student id, email, teacher contact details, the calendar link, cookies, passwords.

PRIVACY.md, PARENTS.md, STORE.md and the site are written from this section.

## 23. Known gaps (honest list)

- Aeries adapter ❌; Canvas and Classroom ⚠️ never on a real account; Classroom has no grades/materials/schedule.
- No adapter fixtures, no ranking unit tests, no automated core-flow test beyond a jsdom boot.
- Real-extension checks pending: chime, 45 s stop, mid-sitting reload, 📸, fresh-profile install, second-machine Google.
- Hosted coach server: not deployed; API key pending; always-on vs auto-stop undecided.
- Manifest `key` (stable extension ID) undecided because it changes the ID and the Google OAuth clients must follow.
- Summarize on readings vs the annotation policy: undecided.
- Accessibility (labels, focus rings, live regions): not done; needed before the store, not the pilot.
- Placeholders: contact email, policy date, install link.
