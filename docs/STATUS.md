# STATUS — rewritten by Claude Code at the end of every session

**Updated:** 2026-09-15 · **Version:** 0.8.18 (manifest) · **Remote:** https://github.com/benjaminkuzoyan-code/focus-agent (private, `main`; every session ends with a push) · **HEAD:** see `git log -1` · **Working tree:** clean after this session's commit.

## This session (2026-09-15): 👁 PDF pages read by eye + 🎬 video summaries (v0.8.18) — spec §11.1, §12.1

| Feature | What shipped | Regression |
|---|---|---|
| 👁 PDF pages the coach reads by eye | `FA.pdfText` now returns per-page text counts + the bytes; `FA.pdfPages.render` draws chosen pages to JPEG (pdf.js, 1400px). Pages with < 150 chars of text layer (scans, figures, worksheets) go to the new bridge method `readPage` one at a time (cap 10 per PDF): transcription (handwriting too) + a plain description of each figure/diagram/graph/equation, appended to the file's text as `[page N — read by eye]`. Chip shows 👁 progress and count; simple mode keeps the old text-only path. Only text is stored | `security_tests.py`: readPage needs an image; student prompt = transcription + figures, never key ideas |
| 🎬 summarize the video | Chip in ⋯ + coach offer after Smart Start opens a YouTube link. Captions read from the open tab (page-world script: `ytInitialPlayerResponse` → caption track, `fmt=json3`; refetches the page after in-page navigation; prefers human over auto captions), merged into ≤14k chars with timestamps. New bridge method `videoSummary` applies the §10 annotation rule: "notes on video" graded → what / why / listen for / moments to pause at / questions; otherwise summary + key moments (tap → seeks the tab, or opens it at `t=`) + terms + questions + "shown but not said". **Frames toggle** (⚙, off by default): seeks the video to 8 evenly spaced moments, `captureVisibleTab` each (800px JPEG), restores position/play state, sends them as `imageDataUrls`. Transcript joins the files (`kind: "video"`) for practice tests. Smart Start no longer parks a tab whose host the assignment links to; the session carries `allowedHosts` and the worker's drift nudge skips them | `security_tests.py`: graded notes → no summary; problem-set → summary + 3 frames counted; 12 frames → 400; non-image frame → 400; question → answer mode |
| Bridge: multiple images | `imageDataUrls` (list, ≤ 8 + 1) validated like the single image; both engines take a list (API: image blocks in order; claude-cli: numbered temp files, "look at each in order"). `IMAGE_REQUIRED_METHODS`, `MAX_IMAGES` | mock reports `images` count |

- `npm test` → security **85/85** (7 new) · boundary 28/28 · background 14/14 · docops 17/17. Smoke: same 6 pre-existing failures.
- ⚠️ Never run for real: a scanned PDF through `readPage`, a real YouTube tab (the caption endpoint is undocumented and can change; failure mode = coach says captions weren't readable), the frames pass (needs the tab visible ~8 s). Bridge restarted on Ben's Mac with the new methods (`/health` lists `readPage`, `videoSummary`).
- Competitors for these two features (for the vault note): NotebookLM (PDF + YouTube captions), Turbolearn / Knowt / StudyFetch (lecture video → notes), Eightify / Glasp (YouTube summary extensions). None live inside the assignment.

## This session (2026-09-14): missing/overdue finally shown + pinned, Smart Start opens the assignment's links, 📷 photo of my page (v0.8.17)

| Ask | Root cause | Fix | Regression |
|---|---|---|---|
| Missing assignments never appear, never prioritized | `adapters/blackbaud.js` treated `assignment_status` 2 as "completed" (the header comment said so). Live feed 2026-09-14: status 2 = **overdue** (19 of 76 items), `missing_ind` sits on status 1/2/4. `isFinished` dropped all of them; the 14-day lookback hid the rest | `isFinished` = status 1 or 4 AND not missing; 60-day lookback; `a.overdue`; `urgencyScore` +2000 for teacher-flagged missing; `FA.isBehind`; the list pins a red **⚠️ N missing / overdue** section at the top with MISSING / OVERDUE badges and "was due …"; the hero pick never skips missing work (a brain pick that does is ignored); the pick prompt is told the rule | `smoke-panel.js`: section pinned, MISSING first, OVERDUE badged, hero = the missing one |
| Smart Start doesn't open the links inside the assignment | Teacher-attached links/files are NOT in `long_description` — they come from `/api/assignment2/read/<assignment_id>/?personaId=2` (`LinkItems`, `DownloadItems`). `a.links` was empty for every assignment whose links were attached rather than typed. Second cause: a cached `setupPlan` built when links were empty was reused forever | adapter fetches attached links for pending items (4 at a time, in-memory cache), attached first; `FA.resolveOpens({allLinks:true})` opens every assignment link whatever the plan says (cap 8, was 3); cached plans carry a `linksSig` and are dropped when the links change | `smoke-panel.js`: both attached links opened |
| Upload a photo of what I'm working on → annotation + summary | 📷 existed only as a dev chip that ticks checklist steps | student-facing **📷 photo of my page** chip + paste into the chat box + drop on the work view → same pipeline as 📸 (`analyzeImage`), bridge told `source: "photo"` (reads handwriting); `build_read_screen` now applies the annotation rule per assignment: summary + key ideas + quotes-with-why + up to 10 questions when annotating isn't graded, orientation + a one-line why when it is; dev always full | `security_tests.py` 78/78 (4 new: unknown → orientation, graded annotation → orientation, problem-set photo → summary allowed, question → answer mode) |

- `npm test` → security 78/78 · panel boundary 28/28 · background 14/14 · docops 17/17. `npm run smoke` → 6 failures, **all pre-existing** (checkpoint/paper-mode/worker-ended/dev-toggle/dev-write; identical on the stashed tree) — not touched this session.
- ⚠️ Not yet run in the real extension: needs a reload + ↻ on myPoly. Expect ~19 overdue items to appear at the top; "In-Class Work" (History) and "Problem Set 0: Scratch" are the two teacher-marked MISSING ones as of today.

## This session: Codex review R1–R4 of 7c65bbd, all four fixed

| Finding | Fix | Regression |
|---|---|---|
| **R1** panel allowed developer actions when the role was missing/none/stale | `devAllowed()` needs a positive, current `role: "dev"` bound to the exact server + code in settings (`FA.bridgeSig`); `initCoach` clears authorization before every probe, ignores out-of-order answers, maps a role-less (old) server to `none`, and a failed refresh leaves nothing behind; the settings handler re-applies role UI before and after re-probing | `scripts/test-panel-boundary.js` (28 cases) |
| **R2** negative/lying `Content-Length` bypassed the cap; invalid base64 reached the model | length must be digits, ≥ 2, ≤ cap (411/400/413) **before** the read; the body must be exactly that long; request must be an object with a registered string `method` and an object `payload`; images must match the data-URL grammar, decode as strict base64, be non-empty and under the cap, all **before** any model call | server harness: 12 new cases |
| **R3** `RuntimeError` text (incl. provider refusal explanations) reached the client; unvalidated `method` reached the log | one `CoachError(public, detail)` type: clients get fixed sentences (`declined` → 422, `brain down`, `unreadable reply`, generic); `detail` is never sent or logged; logs carry a pseudonymous caller id (sha256 prefix), a registered method name or `invalid-method`, and the error class | server harness: refusal / crash / bad-reply cases + 7 log-sentinel checks |
| **R4** a hosted code named `local` got the developer role | identity is `(name, open_local)`; the local-developer exception is a property of the connection (no codes, not hosted, loopback peer), never of a name; `token` refuses reserved/invalid names | server harness: hosted `local` code → student, writeStep 403; reserved names refused |

## Verified (deterministic, no model, no key, isolated HOME)

- `python3 scripts/security_tests.py` → **75/75.** Auth (none/wrong/revoked/reload), origins (web page 403 on GET/POST/preflight; extension echoed), roles on `/health`, students refused `writeStep`/`answerAll`/`editDoc` with zero model calls, student flags (`devMode`, `mode:answer`, voice, doc target) → tutor prompt with no docops and no voice, student screenshot → orientation only, learning features (chat, precheck, practiceTest, summarize, explain) still 200, developer code → developer prompt/docops/full overview, framing attacks (negative, non-numeric, understated, overstated lengths) → 4xx with zero model calls, bad/non-image/empty images → 400, provider refusal/crash/bad reply → fixed sentences, no sentinel in logs, pseudonymous ids in logs, hosted `local` name → student, reserved names refused at mint, tokens-file `dev` word, hosted-without-API refuses to start, open loopback = dev, `FA_LOCAL_ROLE=student`.
- `node scripts/test-panel-boundary.js` → **28/28.** Real `devAllowed`/`applyRoleUI`/`applyDocOpsFromReply`/`autoActionsOnDone`/`formatMyDoc`/`initCoach` in a VM: missing / none / student / role-less server / stale-sig dev → 0 doc writes, 0 calendar writes, switch disabled, mode row hidden; current dev → 1/1; dev with switch off → blocked; student **format my doc still runs**; outline creation gated on plan + Google, not role (source check); failed refresh clears role; wrong code → `badToken` + role none; old server → none; out-of-order late "dev" answer ignored.
- `node scripts/test-docops.js` → 17/17.
- Codex's evidence probes (`reviews/evidence/2026-09-12-boundary-probes.py`) re-run: negative length 411 / 0 calls, list method 400 no echo, bad base64 400 no model, no marker in log, hosted `local` → student + 403, fake refusal → 422 without the explanation. Its panel probe no longer runs as written (it slices `initCoach` without the new `FA.bridgeSig` line); the same cases are in `test-panel-boundary.js`.

## Untested (say so before relying on it)

- Live model behavior on the retained learning inputs (no API key yet). Prompt facts are proven; outputs are not.
- Real extension reload, fresh Chrome profile install, 📸 `captureVisibleTab`, chime, 45 s auto-stop in the real extension.
- Real Google OAuth on a second device; token isolation; whether format/outline succeed against a live Doc. Only the code paths and their gating are verified.
- Hosted deployment: HTTPS, proxy placement, real extension `Origin` values, Fly cold start vs the health probe.
- Packaging (S4) and fallback copy (S5): **not started.** `scripts/package-store.sh` still omits `viewer/` and `offscreen/`; 4 user-visible strings still say to run python3.

## Student Google Docs features (kept)

Read the Doc into chat / precheck · create an outline doc (new doc, client-side, gated on plan + Google connected) · format my doc (styling only, names the doc, links it). Model-authored edits, write this step, answer these, autopilot, auto-complete: developer role only, enforced on the server and mirrored in the panel.

## Classroom: assignments only

`adapters/classroom.js` scrapes the To-do page: title, course label, due date, link; points 0. **No grades, no materials/syllabus, no schedule.** Those do not exist and are not implied by Docs OAuth; they would need a separate Classroom API integration (Cloud project, Classroom scopes, school allow-listing for under-18 accounts) that has not been designed or verified.

## 2026-09-13 batch one (full-check fixes, hard bugs)

Fixed + regression-tested: clock alarms re-armed after a worker restart (`rearmActiveSession`); rules fallback no longer wipes the checklist / prints "first move: undefined" (`MockCoach.prototype.breakdown.call`); Classroom ids parsed from the href (stable across fetches); Blackbaud fetch starts 14 days back (overdue work appears); chunk chip below elapsed can't shorten the log; timeout/idle stops no longer replay as "completed"; worker never opens an interactive Google sign-in; typing indicator cleared in `finally` (work chat + explain); null-record guard in the worker's stop path; dead auto-complete toggle disabled. New `scripts/test-background.js` (14 cases: re-arm on startup/install, one-shot alarm, single chime, 45 s stop logs exactly planned minutes, extend, race with the panel). Full check list: `~/focus agent business/reviews/2026-09-12-full-check-claude.md`.

## 2026-09-13 batches two–four

- **Copy (0.8.13):** no student-visible bridge/python/myPoly/Ben strings; "simple mode" instead of "rules"; developer row hidden unless the server granted dev; coach link + code explained.
- **First run + primary pick (0.8.14):** `renderFirstRun` (three steps with inline buttons, diagnostics behind a fold); `#pick-hero` = one full-width ▶ Smart Start for the coach's pick, above the time row.
- **Packaging + storage (0.8.15):** `scripts/package-store.sh` ships `viewer/` + `offscreen/`, verifies every referenced path exists, prints a SHA-256; `--friends` writes `build.json` and the panel removes every developer control at boot (`applyBuildFlag`). `package.json`: `npm test` runs all four suites. Storage: quota errors surface as a notice; finished assignments lose thread/files/tests after 30 days; `filesForBrain` reads only the highlight keys it needs.
- Built: `dist/focus-agent-0.8.15.zip` (store) and `-friends.zip`; 6.8 MB each (pdf.js). **Not yet installed on a fresh profile** — Ben's step.

- **Google hygiene + honest docs (0.8.16):** OAuth scope `drive` → `drive.file` (the "from Drive" picker is developer-only now); teacher emails no longer stored; PRIVACY.md, PARENTS.md, STORE.md (permission table covers every manifest permission, description matches shipped features, "bridge is stripped" claim removed), `site/index.html` and `site/privacy.html` all describe what ships: the coach client ships, nothing is sent without a code, what is sent with one. Still placeholders: contact email, install link, policy date. **Not done:** manifest `key` (changes the extension ID → Ben must update the Google OAuth clients in the Cloud console first; decision card).

## Open items, in order

1. Fresh-profile install of the friends zip; real-extension run (📸, chime, 45 s stop, time-up after a reload).
2. Manifest `key` (stable extension ID across machines) and the `drive` → `drive.file` review before a friend uses Google features.
3. Aeries: DevTools discovery session on a real Student Portal login, then `adapters/aeries.js` + a `detect.js` type.
4. Hosted deploy once the API key lands; then the live 6–10 example behavior check.

## What Ben must do

API key → `~/.focus-agent/api_key`; mint codes (`python3 bridge/coach_server.py token ben dev`, `… token <friend>`); restart the bridge; reload the extension (0.8.11); hosting choice.
