# STATUS — rewritten by Claude Code at the end of every session

**Updated:** 2026-09-13 · **Version:** 0.8.16 (manifest) · **Remote:** https://github.com/benjaminkuzoyan-code/focus-agent (private, `main`; every session ends with a push) · **HEAD:** see `git log -1` · **Working tree:** clean after this session's commit.

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
