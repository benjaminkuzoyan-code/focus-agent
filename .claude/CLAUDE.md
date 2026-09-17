<!-- GSD:project-start source:PROJECT.md -->

## Project

**Focus Agent**

Focus Agent is a Chrome side-panel extension for a high-school or college student who wants to do well and can't get started. It reads the student's own school portal (Blackbaud today; Canvas, Google Classroom, and Aeries planned/partial), picks the one assignment to start, opens what's needed, runs a focus clock with real structure, and puts an AI coach beside the student that knows the assignment. The coach explains, checks, and quizzes — it never does the work. Currently at v0.8.21, in pilot with the founder (Ben) and about to expand to 4–5 friends he's onboarding in person.

**Core Value:** One tap (Smart Start) gets a student from "can't start" to "working, with structure they can't talk their way out of, and a tutor beside them that never ghostwrites." If the clock's structure, the tutor boundary, or the portal-reading promise breaks, nothing else matters.

### Constraints

- **Legal/Compliance**: Must be legal in every US state and give no school a reason to act against a student for using it — only reads what the student's own login can already see, never bypasses a school control, never shares a password. Any feature that can't meet this is cut, not shipped.
- **Privacy**: Portal cookies and passwords never leave the browser; coach requests carry only what the feature needs, are never stored server-side, and nothing is sent without a coach code. Never sent anywhere, ever: cookies, passwords, name, student id, email, teacher contact details, the calendar feed link.
- **Product policy (tutor, not ghostwriter)**: The coach never produces text a student would hand in, never gives the final answer to graded work, and never does an annotation the assignment asked the student to do — enforced server-side for every student code; developer mode exists only for Ben and is never distributed.
- **Tech stack**: Chrome extension (Manifest V3-style side panel) + Python stdlib coach server with a mock engine for tests; `npm test` runs four suites before every friends build.
- **Distribution**: Pilot distributes via unpacked zip (`npm run package:friends`); Chrome Web Store listing is a later concern.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Gap 1 — Google OAuth on school-managed Chrome + a stable extension ID

### What's already right (don't rebuild this)

| Door | Mechanism | When it's used |
|------|-----------|-----------------|
| 1 | `chrome.identity.getAuthToken()` reading the `oauth2` block in `manifest.json` | Chrome profile is signed into an account Google will silently authorize (works on most personal/unmanaged Chrome profiles) |
| 2 | `chrome.identity.launchWebAuthFlow()` against a separate **Web application** OAuth client, redirect = `chrome.identity.getRedirectURL()` → `https://<ext-id>.chromiumapp.org/` | Door 1 fails (school Workspace admin disabled third-party OAuth for the account) — opens Google's own account chooser so the student can pick a personal Gmail regardless of which account Chrome is signed into |

### What needs to happen: stable extension ID via manifest `key`

### School-managed accounts: why door 1 gets blocked, and what actually fixes it

### The Testing-mode 7-day re-auth trap (new finding, not yet in SPEC.md)

- **Cheap fix now:** make sure `FA.google.getToken()`'s failure path (already retried once on 401 in `api()`) surfaces a clear "reconnect Google" prompt in the settings row rather than a raw error — the panel already has a "Google connect" affordance, so this is a UX/error-message tweak, not new plumbing.
- **Real fix before wider rollout:** move the OAuth consent screen from Testing to **In production**. For under ~100 users this does not require Google's full security (CASA) assessment — that's only mandated once a restricted-scope app exceeds 100 users — but it does require basic verification: an app homepage, a privacy policy URL (`PRIVACY.md` already exists — publish it, e.g. via GitHub Pages), a support contact, and a written justification per sensitive/restricted scope. Google's review for a small, non-restricted-scope app is often days; once Classroom scopes (restricted, see Gap 2) are added, expect longer and possibly a request for a demo video. Start this early since it's not urgent-blocking but has real lead time.

## Gap 2 — Canvas grades/schedule and Google Classroom (grades, materials, schedule)

### Canvas: no new auth, just new endpoints

- **Grades:** `GET /api/v1/users/self/enrollments?state[]=active&include[]=current_period_scores` (or the simpler `?include[]=total_scores`) returns one enrollment object per course with a `grades` sub-object (`current_score`, `final_score`, `current_grade`). This mirrors the shape `adapters/schema.js` already expects for Blackbaud grades — should normalize cleanly.
- **Materials:** already partially covered — `planner/items` and `courses/:c/assignments/:a` (already used) carry most of what's needed; course-level "Files"/"Modules" would need `GET /api/v1/courses/:id/modules?include[]=items` if module-level materials (not just assignment attachments) are wanted.
- **Schedule:** this is the one genuine limitation, not just an unbuilt endpoint. Canvas models *assignment due dates* (already read via the planner API) but does **not** generally model *class meeting times / bell schedule* — that's usually owned by the school's separate SIS (which, notably, is exactly what Aeries is for schools that use it). `GET /api/v1/users/:id/calendar_events` exists but returns calendar entries (assignments-as-events, manually created events), not a timetable. **Recommendation:** scope "Canvas schedule" down to "today's/this week's due dates," which the existing planner data already supports, rather than promising a bell schedule Canvas likely can't provide for most schools. Confirm against a real account before committing to more.

### Google Classroom: real OAuth, the heaviest of the three gaps

## Gap 3 — Deploying the coach server off Ben's Mac

### Recommended: Fly.io Machines, scale-to-zero (already configured in `deploy/fly.toml`)

- Fly Machines are Firecracker microVMs designed specifically for fast start/stop, which is what makes `auto_stop_machines = "stop"` / `auto_start_machines = true` / `min_machines_running = 0` (already in `fly.toml`) the right pattern: the app costs ~nothing while nobody's doing homework and wakes on the first request.
- **HTTPS is automatic** — `force_https = true` plus Fly's edge proxy gets a managed cert for the `*.fly.dev` subdomain (or a custom domain via `fly certs add`) with zero extra config. No Caddy/nginx/certbot needed on this path — that's only for the VPS fallback.
- **Secrets are handled correctly already**: the README uses `fly secrets set ANTHROPIC_API_KEY=...` (encrypted, injected as an env var at runtime), not a plaintext value in `fly.toml`'s `[env]` block. This is the correct current pattern — don't change it.
- **Cost, corrected for 2025/2026:** Fly's old free "Hobby" allowance (3 always-free shared-cpu-1x VMs) was deprecated in **October 2024** — new accounts need a credit card on file from the start (the README already accounts for this: "a parent's — you're under 18"). Pay-as-you-go for a shared-cpu-1x/256MB machine is roughly $0.0000008/second (~$2/month if it ran continuously); scaled to zero and only waking for actual coach calls from 5-10 students, expect low single-digit dollars/month — the README's existing "~$0-3/month" estimate is still accurate, no change needed there.
- **What to actually test before calling this done** (the real content of this gap):

### Fallback: a small Linux VPS + systemd + Caddy (already in `deploy/focus-agent-bridge.service` + README Option B)

### What NOT to use, and why

| Avoid | Why | Use instead |
|-------|-----|--------------|
| Wrapping `coach_server.py` in Flask/FastAPI + gunicorn/uvicorn "to look more production" | Adds dependencies and a WSGI/ASGI layer for no benefit at this traffic scale — `ThreadingHTTPServer` comfortably handles a handful of concurrent requests from 5-10 students, and every security test already targets the stdlib server directly | Ship it as-is |
| AWS Lambda / any FaaS platform | The server keeps an **in-memory** per-access-code daily call cap (`DAILY_CAP`, "resets on restart, by decision" per SPEC §19) and holds a 150s-tolerant long-running call; FaaS cold-starts a fresh instance per invocation/idle gap, which would reset that counter far more often than intended and silently defeat the abuse guard, unless it's moved to an external store — unnecessary complexity for a 5-10 person pilot | A persistent process host (Fly Machine or VPS) where "the process" and "the cap's memory" are the same lifetime |
| Node/Express, or any rewrite to match the "Node coach server" description in the milestone framing | The server is not Node — rewriting it to be Node would be pure risk (all 75 security tests target the Python implementation) for zero product benefit | Deploy the existing Python file as-is |
| ngrok / Cloudflare Tunnel to Ben's own Mac as the **primary** deployment | Directly contradicts the stated goal ("available whenever your laptop is closed") — a tunnel is still tethered to Ben's machine being on | Fly.io (primary) or a VPS (fallback) — both are genuinely always-on independent of Ben's laptop |
| Render.com free tier | Free-tier cold starts run 10-30s+ after ~15 min idle — materially worse than Fly's Machine-wake, and a slow first coach reply during a homework session is the failure mode this project can least afford | Fly.io Machines (scale-to-zero with sub-few-second wake) |
| Railway.app | No ongoing free tier since Aug 2024 (one-time trial credit only); its idle/"serverless" sleep is usage-based like Fly's but is a less mature fit for an arbitrary long-lived TCP process than Fly Machines, which were purpose-built for exactly this start/stop pattern | Fly.io Machines |

## Installation / config summary

# Gap 1 — one-time, before any friend installs the extension

# → paste output into manifest.json "key"; add deploy/extension-key.pem to .gitignore

# → update the Chrome-Extension-type and Web-application-type OAuth clients to the new stable ID

# Gap 2 — Google Classroom, same Cloud project as Docs/Drive/Calendar

# Console: enable "Google Classroom API"

# manifest.json oauth2.scopes: add

#   https://www.googleapis.com/auth/classroom.courses.readonly

#   https://www.googleapis.com/auth/classroom.coursework.me.readonly

#   https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly

# Gap 3 — deploy (existing files, unchanged)

## Version compatibility

| Package | Version | Notes |
|---------|---------|-------|
| `anthropic` (PyPI) | `>=1.5,<2` (latest as of 2026-09) | Currently unpinned in `deploy/Dockerfile` (`pip install anthropic`) — pin a floor so a future breaking SDK release doesn't silently change server behavior on the next `fly deploy` |
| `python` (Docker base) | `3.12-slim` (already pinned in `deploy/Dockerfile`) | Fine, no change needed |
| Chrome MV3 manifest | `manifest_version: 3` (current) | `key` field is supported unchanged across recent/current Chrome versions; no MV3 API deprecations affect `chrome.identity` as used here |

## Sources

- [chrome.identity API reference](https://developer.chrome.com/docs/extensions/reference/api/identity) — HIGH, official Chrome docs; confirmed `getAuthToken` vs `launchWebAuthFlow` split and `getRedirectURL()` behavior
- [Manifest `key` field reference](https://developer.chrome.com/docs/extensions/reference/manifest/key) — HIGH, official; confirmed public/private key split and deterministic-ID mechanism
- [Google Classroom API — Choose scopes](https://developers.google.com/workspace/classroom/guides/auth) — HIGH, official; scope list and `.me.` vs teacher-facing scope distinction
- [Classroom developer best practices — access control enhancements](https://developers.google.com/workspace/classroom/best-practices/access-control-enhancements) — HIGH, official
- [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) — HIGH, official; 100-user audit threshold
- [Manage App Audience (Internal/External, Testing)](https://support.google.com/cloud/answer/15549945) — HIGH, official; Internal requires Workspace-org-owned Cloud project
- [Control which apps access Google Workspace data](https://support.google.com/a/answer/7281227) — HIGH, official; App access control / Trusted-app-by-client-ID flow
- Google Workspace admin help on unconfigured third-party apps and under-18 accounts — MEDIUM (aggregated via search, not a single fetched primary page — confirm with first real Classroom school)
- [Canvas LMS REST API — Enrollments](https://canvas.instructure.com/doc/api/enrollments.html) and [Calendar Events](https://canvas.instructure.com/doc/api/calendar_events.html) — MEDIUM, official docs but summarized via search rather than directly fetched; endpoint shapes are stable/long-documented, low risk
- [Fly.io pricing](https://fly.io/docs/about/pricing/) — HIGH, official; per-second billing confirmed, free Hobby tier deprecation confirmed via multiple independent 2026 sources
- 7-day Testing-mode refresh token expiry — MEDIUM-HIGH, corroborated across Google support threads and third-party OAuth-infra vendor write-ups (Unipile, Nango) describing the same documented Google behavior
- Render/Railway free-tier and cold-start comparisons — MEDIUM, third-party 2026 comparison sites, directionally consistent across multiple independent sources

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
