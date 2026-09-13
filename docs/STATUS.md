# STATUS — rewritten by Claude Code at the end of every session

**Updated:** 2026-09-12 · **Version:** 0.8.10 (manifest) · **HEAD:** see `git log -1` · **Working tree:** clean after this session's commit.

## What shipped this session (brief 001, step 1)

- **Student/developer boundary enforced on the bridge** (`bridge/coach_server.py`). Roles: an access code marked `dev` (`tokens` file: `name code dev`, or `FA_DEV_TOKENS=name`) or the developer's own open loopback bridge = **dev**; every other code = **student**. For students the server forces `devMode:false` and `mode:tutor` before any prompt is built, drops the voice profile, refuses `writeStep` / `answerAll` / `editDoc` with 403 before any model call, and turns 📸 page overview into orientation only (what it is, what to look for, questions; no key ideas, no quotes).
- **Bridge hardening:** browser origin must be `chrome-extension://…` (web pages get 403, CORS echoes the origin instead of `*`); body cap `FA_MAX_BODY` (6 MB) → 413; `/voice/local` is gone on hosted bridges; `HEAD` → 404; hosted start without the API engine now **refuses to start**; logs and client errors carry the error class, never request text.
- **Mock engine** (`FA_ENGINE=mock`) for tests: no model, counts would-be calls, reports role/policy/prompt facts.
- **Panel:** developer controls follow the server's `role` from `/health` (`applyRoleUI`): a student profile cannot enable developer mode, the assistant-mode row is hidden, model-authored doc ops are never applied, autopilot/auto-done stay off. Format-my-doc names the target doc with a link and says words are untouched. Snap messages render the new "as you read, look for" section.
- **`scripts/security_tests.py`:** 43 deterministic cases, all green (see "Tests").

## Student Google Docs features (kept, verified by reading the code)

| Feature | Path | Needs bridge? | Student allowed? |
|---|---|---|---|
| Read the assignment's Doc / active Doc into chat, precheck | `lib/google.js readDoc` (OAuth) or cookie read; `precheck`, `chat` methods | yes for the coach reply | yes |
| Create an outline doc from the checklist (Smart Start) | `lib/google.js createOutlineDoc` — a NEW doc, client-side | no | yes |
| Format my doc (MLA) | `lib/google.js formatDoc` — styling only, client-side | no | yes |
| Model-authored edits (docops), write this step, answer these, autopilot | `editDoc` / `writeStep` / `answerAll` + chat docops | yes | **no** (403 / never offered) |

## Tests

- `python3 scripts/security_tests.py` → 43/43 (auth, origin, roles, refused methods with zero model calls, tutor forcing, orientation-only screenshots, learning features still 200, 413, /voice/local 404, HEAD 404, error-class-only messages, log content, revocation on reload, tokens-file dev word, hosted-without-API refuses, open loopback = dev, `FA_LOCAL_ROLE=student`).
- `node scripts/test-docops.js` → all passed.
- Panel harness (`scripts/harness/`, real Chrome) → boots; role UI checked against a student `/health`.
- **Not run:** live model calls (no API key); real extension reload; fresh-profile install; `captureVisibleTab`, chime, 45 s auto-stop in the real extension (unchanged since 0.8.9, still harness-only).

## Open risks / not done

- Packaging (S4): `scripts/package-store.sh` still omits `viewer/` and `offscreen/`; no `--friends` build; no fresh-profile test. **Next session.**
- Fallback copy (S5) still tells users to run `python3 bridge/coach_server.py` in 4 places.
- Google: full `auth/drive` scope; no manifest `key` (unpacked installs on other machines get a different extension ID → web OAuth redirect mismatch). `listRecentDocs` is the only caller needing full drive.
- Classroom: assignments only (DOM scrape of the To-do page: title, course, due, link; points 0). **No grades, no materials/syllabus, no schedule** — those would need the Classroom API (Cloud project + Classroom OAuth scopes + school allow-listing for under-18 accounts). See the Classroom table in the 2026-09-12 report.
- Aeries: no adapter, no student API; needs a DevTools discovery session on a real Student Portal login, then a new `adapters/aeries.js` + `detect.js` type.
- Hosted bridge never run off this Mac; API key pending.

## What Ben must do (only he can)

1. API key into `~/.focus-agent/api_key` (or the host's secret store) — then the bridge auto-selects the API engine.
2. Mint codes: `python3 bridge/coach_server.py token ben dev` (his), `… token amy` (friends). Restart the bridge to load them.
3. Reload the extension (manifest 0.8.9 → 0.8.10).
4. Decide hosting (always-on vs auto-stop) when deploying.
