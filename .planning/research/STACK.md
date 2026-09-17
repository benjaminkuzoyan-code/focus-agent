# Stack Research — Closing the Three Known Gaps

**Domain:** Chrome MV3 side-panel extension (student portal reader + tutor coach) + a tiny Python coach server
**Researched:** 2026-09-17
**Confidence:** HIGH on gaps 1 and 3 (official docs, cross-checked); MEDIUM on gap 2's Canvas grade/schedule endpoint details and the exact scope-verification threshold (needs confirmation against a real account / a real submission, as SPEC.md already flags)

**Scope note:** This file does NOT re-litigate the extension/server architecture — that's built and working. It answers three specific "how do we close this" questions from PROJECT.md's Active list. One correction up front: PROJECT.md/task framing calls this a "Node coach server" — it is not. `bridge/coach_server.py` is pure-Python stdlib (`http.server.ThreadingHTTPServer`, `pip install anthropic`), no Node, no Flask/FastAPI. All deployment recommendations below are for that Python process, not a Node app. There is also no separate "Node" anything in this repo (`package.json` only runs the extension's test/package scripts).

---

## Gap 1 — Google OAuth on school-managed Chrome + a stable extension ID

### What's already right (don't rebuild this)

`lib/google.js` already implements the current (2025/2026) standard two-door pattern for MV3 extensions and should be kept as-is:

| Door | Mechanism | When it's used |
|------|-----------|-----------------|
| 1 | `chrome.identity.getAuthToken()` reading the `oauth2` block in `manifest.json` | Chrome profile is signed into an account Google will silently authorize (works on most personal/unmanaged Chrome profiles) |
| 2 | `chrome.identity.launchWebAuthFlow()` against a separate **Web application** OAuth client, redirect = `chrome.identity.getRedirectURL()` → `https://<ext-id>.chromiumapp.org/` | Door 1 fails (school Workspace admin disabled third-party OAuth for the account) — opens Google's own account chooser so the student can pick a personal Gmail regardless of which account Chrome is signed into |

This is exactly what Chrome's own docs and every current MV3 OAuth guide describe as the split: `getAuthToken`/the manifest `oauth2` block is Google-only and paired with a **Chrome Extension**-type OAuth client; `launchWebAuthFlow` is the general-purpose door (any provider) and must be paired with a **Web application**-type OAuth client using the `chromiumapp.org` redirect — never a "Desktop/Installed app" client type, which uses a different (loopback) redirect scheme that extensions can't receive. Both client IDs stay in `manifest.json`/`lib/google.js` respectively and both read the same `scopes` list from the manifest's `oauth2` block, so widening scopes (see Gap 2) is a one-line change that both doors inherit automatically.

**Confidence: HIGH** — confirmed against Chrome's official `chrome.identity` reference and cross-checked against three independent 2025/2026 MV3 OAuth guides.

### What needs to happen: stable extension ID via manifest `key`

An MV3 extension's ID is normally derived from wherever it's loaded from — a fresh "load unpacked" on a different machine (every friend's laptop) produces a **different** extension ID, which breaks both OAuth doors (door 1's Chrome-Extension-type OAuth client is bound to one ID; door 2's redirect URI `https://<ext-id>.chromiumapp.org/` literally contains the ID). The fix is the manifest `key` field, and it is the standard, Google-documented mechanism for this exact problem:

1. Generate an RSA keypair once, from the repo root (do this before any friend loads the extension):
   ```bash
   openssl genrsa -out deploy/extension-key.pem 2048
   openssl rsa -in deploy/extension-key.pem -pubout -outform DER | openssl base64 -A > /tmp/pubkey.b64
   ```
2. Put the contents of `/tmp/pubkey.b64` (one line, no header/footer) into `manifest.json`'s top-level `"key"` field.
3. Load the extension unpacked once; `chrome://extensions` now shows the **permanent** ID — it will be identical on every machine, every reload, every fresh "load unpacked" from the friends zip, forever, as long as `manifest.json` ships with this `key` field.
4. Update both Google OAuth clients to that ID:
   - **Chrome Extension** client (used by door 1 / `getAuthToken`): set its "Item ID" / "Application ID" to the new stable ID.
   - **Web application** client (used by door 2 / `launchWebAuthFlow`): set its Authorized redirect URI to `https://<stable-id>.chromiumapp.org/`.
5. Rebuild `npm run package:friends` — the friends zip now carries the same `key`, so it gets the same extension ID on a friend's machine as it does on Ben's, without a Chrome Web Store listing.

**Important nuance — the `key` field is the PUBLIC key.** It is not a secret and is fine to ship inside the friends zip (this is exactly what Chrome does for published extensions too). Only `deploy/extension-key.pem` (the **private** key) must stay out of git — add it to `.gitignore` and keep it somewhere Ben can retrieve it (anyone who gets the private key could, in principle, publish an extension with the same ID, which matters far more once this is Web-Store-listed than during an unpacked pilot, but there's no reason not to protect it now). This "public key in manifest, private key kept out of git" split is the universally documented approach (Chrome's own `key` manifest reference, plus every current guide on pinning unpacked extension IDs) — there is no alternative mechanism in MV3 for a stable unpacked ID.

**Confidence: HIGH.**

### School-managed accounts: why door 1 gets blocked, and what actually fixes it

The "Service has been disabled for this account" failure Ben already saw on Poly's Workspace is a **Workspace Admin Console** setting (Security → Access and data control → API controls → App access control), not something the extension can route around — by design, this is exactly what that control exists to do. Two things follow:

1. **The personal-Gmail fallback (door 2) is the correct, and only reliable, fix for the pilot.** It doesn't touch the school's Workspace policy at all, because the student authenticates a completely different (personal) Google account through Google's own hosted account-chooser page, not the school-managed one Chrome is signed into. This must work unconditionally, since Ben can't get every friend's school IT department to cooperate.
2. **Optionally**, if a friend's school admin is cooperative, the admin can explicitly trust Focus Agent's OAuth client ID for the *school* account too, via Admin console → Security → API controls → App access control → Manage app access → **Configure new app** → paste the OAuth Client ID → access level **Trusted**. This is the identical mechanism needed for Classroom in Gap 2 below — worth doing once per willing school, but treat it as a nice-to-have, not a blocker, since door 2 already covers the "school says no" case.

**Confidence: HIGH** on the mechanism; **MEDIUM** on "this is definitely what happened at Poly" specifically, since SPEC.md's account of the exact error string is the only first-hand data point — the admin-console explanation matches it closely enough to act on.

### The Testing-mode 7-day re-auth trap (new finding, not yet in SPEC.md)

Because the app's Google Cloud project (`focus-agent-507019`) is tied to Ben's personal Gmail, not a Workspace org, the OAuth consent screen **cannot** use the "Internal" user type (Internal requires the Cloud project to belong to a Google Workspace organization) — it must stay **External**. While an External app's OAuth consent screen is in **Testing** status (the default, and where it almost certainly is today), every test user's authorization — and any refresh token issued — **expires 7 days after consent**, regardless of scope sensitivity. In practice this means every pilot friend will be silently kicked back to a re-consent prompt about once a week, which will look like a random Google Doc-connect failure if nobody expects it.

Two ways to handle this, and they're not mutually exclusive:
- **Cheap fix now:** make sure `FA.google.getToken()`'s failure path (already retried once on 401 in `api()`) surfaces a clear "reconnect Google" prompt in the settings row rather than a raw error — the panel already has a "Google connect" affordance, so this is a UX/error-message tweak, not new plumbing.
- **Real fix before wider rollout:** move the OAuth consent screen from Testing to **In production**. For under ~100 users this does not require Google's full security (CASA) assessment — that's only mandated once a restricted-scope app exceeds 100 users — but it does require basic verification: an app homepage, a privacy policy URL (`PRIVACY.md` already exists — publish it, e.g. via GitHub Pages), a support contact, and a written justification per sensitive/restricted scope. Google's review for a small, non-restricted-scope app is often days; once Classroom scopes (restricted, see Gap 2) are added, expect longer and possibly a request for a demo video. Start this early since it's not urgent-blocking but has real lead time.

**Confidence: MEDIUM-HIGH.** The 7-day Testing-mode expiry and the Internal/Workspace-org requirement are both confirmed in Google's own support docs; the exact verification turnaround time is not something Google publishes precisely and varies case to case.

---

## Gap 2 — Canvas grades/schedule and Google Classroom (grades, materials, schedule)

These are architecturally very different from each other and should be scheduled as separate roadmap items.

### Canvas: no new auth, just new endpoints

Canvas already works the same way Blackbaud does — `adapters/canvas.js` calls `fetch(path, { credentials: "include" })` against the school's own Canvas domain using the student's existing browser session cookie, no OAuth, no Cloud project, no admin allow-listing. That pattern extends directly to grades and schedule; no new `host_permissions` or content-script matches are needed since `*.instructure.com` (and the "connect my school" custom-domain flow) are already registered.

- **Grades:** `GET /api/v1/users/self/enrollments?state[]=active&include[]=current_period_scores` (or the simpler `?include[]=total_scores`) returns one enrollment object per course with a `grades` sub-object (`current_score`, `final_score`, `current_grade`). This mirrors the shape `adapters/schema.js` already expects for Blackbaud grades — should normalize cleanly.
- **Materials:** already partially covered — `planner/items` and `courses/:c/assignments/:a` (already used) carry most of what's needed; course-level "Files"/"Modules" would need `GET /api/v1/courses/:id/modules?include[]=items` if module-level materials (not just assignment attachments) are wanted.
- **Schedule:** this is the one genuine limitation, not just an unbuilt endpoint. Canvas models *assignment due dates* (already read via the planner API) but does **not** generally model *class meeting times / bell schedule* — that's usually owned by the school's separate SIS (which, notably, is exactly what Aeries is for schools that use it). `GET /api/v1/users/:id/calendar_events` exists but returns calendar entries (assignments-as-events, manually created events), not a timetable. **Recommendation:** scope "Canvas schedule" down to "today's/this week's due dates," which the existing planner data already supports, rather than promising a bell schedule Canvas likely can't provide for most schools. Confirm against a real account before committing to more.

**Confidence: MEDIUM.** The enrollments/grades endpoint shape is well-documented and stable in Canvas's public API docs, but — per SPEC.md's own honest-gaps list — this has never been run against a real Canvas account, so treat exact param names as "verify on first real test," not gospel.

### Google Classroom: real OAuth, the heaviest of the three gaps

This reuses the exact two-door OAuth architecture from Gap 1 (same manifest `oauth2.scopes` list feeds both `getAuthToken` and `launchWebAuthFlow`) — there is no new auth *architecture* to build, only new scopes, a newly-enabled API, and (per school) a manual admin allow-listing step.

**Setup in the existing Cloud project (`focus-agent-507019`):**
1. Console → APIs & Services → Enable APIs → enable **Google Classroom API**.
2. Add to `manifest.json`'s `oauth2.scopes` (both OAuth clients inherit this automatically):
   - `https://www.googleapis.com/auth/classroom.courses.readonly` — the student's own course list
   - `https://www.googleapis.com/auth/classroom.coursework.me.readonly` — "view your course work **and grades**" (this is the scope that gets the assignment + the student's own grade in one call — it is the *student-facing* variant)
   - `https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly` — materials posted to a course that aren't tied to a specific graded item
   - Add `classroom.student-submissions.me.readonly` only if `coursework.me.readonly` doesn't already surface what's needed in testing — don't request both by default (incremental-scope principle Google explicitly recommends, and fewer scopes means a lighter consent screen for a nervous 16-year-old to click through).
3. **Do not** request `classroom.coursework.students.readonly` / `classroom.*.students.*` variants — those are the *teacher/admin* scopes ("view coursework for students in classes you teach or administer"). Requesting a teacher-facing scope from a student-facing app is a mismatch that (a) triggers extra scrutiny in Google's verification review and (b) looks alarming on the consent screen a student or a suspicious parent/IT admin reads ("this app can see grades for a whole class"). The `.me.` scopes are the correct, narrower, student-only equivalents and are what Google's own docs point developers of student-facing apps toward.
4. Endpoints once scoped: `GET https://classroom.googleapis.com/v1/courses` (student's active courses), `.../courses/{id}/courseWork` (assignments), `.../courses/{id}/courseWork/{workId}/studentSubmissions?userId=me` (this student's grade/state on it), `.../courses/{id}/courseWorkMaterials` (materials).

**School allow-listing for under-18 accounts — this is a manual, per-school step, not code:**

Google Workspace for Education lets an admin mark student accounts `<18`, and by default **those accounts are blocked outright from unconfigured third-party apps** (stricter than the "unverified app" warning an adult account gets — under-18 accounts don't get a click-through option; the student sees a hard block with a "request access" button that emails the admin). The admin's fix, without needing a Google Workspace Marketplace listing:

1. Admin console → Security → Access and data control → API controls → **App access control** → Manage app access.
2. **Configure new app** → "OAuth App Name Or Client ID" → paste Focus Agent's OAuth Client ID (from Cloud Console → Credentials).
3. Set access level to **Trusted** → Finish. (Google can take a few hours to index a newly created client ID before it's searchable this way — do this a day ahead of a friend's first Classroom test, not five minutes before.)

This has to happen once per friend's school and is fundamentally a **relationship/coordination task** ("find out at the first Classroom friend's school," per SPEC.md), not an engineering task — flag it in the roadmap as a dependency with lead time, separate from the code that reads Classroom once access is granted.

**Fallback if a school refuses Classroom API access entirely:** `adapters/classroom.js` already has a DOM-scrape v1 (no-OAuth) path for `classroom.google.com` per its own file comment — keep that as the no-OAuth fallback for schools that won't allow-list the app, the same way the personal-Gmail door is the fallback for Docs. It gives assignments/materials from the page a student can already see, just not grades cleanly (grades aren't reliably in Classroom's DOM the way they are in the API).

**Confidence: HIGH** on scope names, API enablement, and the admin allow-listing mechanism (all confirmed against Google's own developer/admin docs); **MEDIUM** on the exact under-18 blocking UX (Google's docs describe the block-and-request-access flow generally for "unconfigured apps," and age-based Workspace for Education settings separately — the precise interaction of the two wasn't found in a single authoritative source, so verify with the first real Classroom friend rather than assuming).

---

## Gap 3 — Deploying the coach server off Ben's Mac

**The deployment plan already exists in the repo (`deploy/Dockerfile`, `deploy/fly.toml`, `deploy/focus-agent-bridge.service`, `deploy/README.md`) and matches current (2025/2026) best practice for this exact shape of workload — a tiny, cookie-free, key-holding HTTP process serving 5-10 people with bursty, homework-hours-only traffic.** The remaining gap is testing it, not designing it. This research validates the existing plan against current provider status/pricing and flags the two things worth actually testing.

### Recommended: Fly.io Machines, scale-to-zero (already configured in `deploy/fly.toml`)

- Fly Machines are Firecracker microVMs designed specifically for fast start/stop, which is what makes `auto_stop_machines = "stop"` / `auto_start_machines = true` / `min_machines_running = 0` (already in `fly.toml`) the right pattern: the app costs ~nothing while nobody's doing homework and wakes on the first request.
- **HTTPS is automatic** — `force_https = true` plus Fly's edge proxy gets a managed cert for the `*.fly.dev` subdomain (or a custom domain via `fly certs add`) with zero extra config. No Caddy/nginx/certbot needed on this path — that's only for the VPS fallback.
- **Secrets are handled correctly already**: the README uses `fly secrets set ANTHROPIC_API_KEY=...` (encrypted, injected as an env var at runtime), not a plaintext value in `fly.toml`'s `[env]` block. This is the correct current pattern — don't change it.
- **Cost, corrected for 2025/2026:** Fly's old free "Hobby" allowance (3 always-free shared-cpu-1x VMs) was deprecated in **October 2024** — new accounts need a credit card on file from the start (the README already accounts for this: "a parent's — you're under 18"). Pay-as-you-go for a shared-cpu-1x/256MB machine is roughly $0.0000008/second (~$2/month if it ran continuously); scaled to zero and only waking for actual coach calls from 5-10 students, expect low single-digit dollars/month — the README's existing "~$0-3/month" estimate is still accurate, no change needed there.
- **What to actually test before calling this done** (the real content of this gap):
  1. **Cold-start latency vs. `CLAUDE_TIMEOUT` (150s).** Fly's own docs describe Machine wake as ~1 second, but that's VM boot, not "Python process up + `anthropic` SDK imported + first request served" — measure the real number for `coach_server.py` specifically. It should be well inside budget, but confirm rather than assume, since a slow first message of the evening is a bad first impression for a focus app.
  2. **No hidden request-length cap on Fly's edge.** Fly Machines don't impose a fixed request timeout on the proxy by default (unlike some PaaS platforms with a hard 30-60s L7 timeout), which matters because a `claude-cli` fallback call can legitimately take up to 150 seconds. Confirm this in practice with one long-running test call through the deployed URL, not just against `127.0.0.1`.
  3. **HTTPS/proxy path end to end** — SPEC.md already flags this as untested; it's the same "hit the public URL from a real Chrome profile with an access code" smoke test either way.

**Confidence: HIGH** — Fly's Machines model, scale-to-zero config shape, and the deprecation of the free Hobby tier are all confirmed against Fly's own current pricing docs; the exact cold-start-in-seconds number for this specific script is something only a real deploy will answer (that's the test to run, not a number to trust from docs).

### Fallback: a small Linux VPS + systemd + Caddy (already in `deploy/focus-agent-bridge.service` + README Option B)

Keep this documented as the fallback it already is: Hetzner CX22 (~€4/mo) or DigitalOcean ($6/mo), the existing `systemd` unit for process supervision/restart-on-crash, and Caddy for HTTPS (`your.domain { reverse_proxy 127.0.0.1:8000 }` — still the correct two-line, auto-Let's-Encrypt pattern in 2025/2026, nothing has changed here). Right choice **only if** Fly's card-on-file / usage-billing model is a blocker; otherwise it's strictly more ops burden (patching, systemd, Caddy config, no scale-to-zero) for a flat monthly cost, which is the wrong tradeoff for "minimal ops burden."

### What NOT to use, and why

| Avoid | Why | Use instead |
|-------|-----|--------------|
| Wrapping `coach_server.py` in Flask/FastAPI + gunicorn/uvicorn "to look more production" | Adds dependencies and a WSGI/ASGI layer for no benefit at this traffic scale — `ThreadingHTTPServer` comfortably handles a handful of concurrent requests from 5-10 students, and every security test already targets the stdlib server directly | Ship it as-is |
| AWS Lambda / any FaaS platform | The server keeps an **in-memory** per-access-code daily call cap (`DAILY_CAP`, "resets on restart, by decision" per SPEC §19) and holds a 150s-tolerant long-running call; FaaS cold-starts a fresh instance per invocation/idle gap, which would reset that counter far more often than intended and silently defeat the abuse guard, unless it's moved to an external store — unnecessary complexity for a 5-10 person pilot | A persistent process host (Fly Machine or VPS) where "the process" and "the cap's memory" are the same lifetime |
| Node/Express, or any rewrite to match the "Node coach server" description in the milestone framing | The server is not Node — rewriting it to be Node would be pure risk (all 75 security tests target the Python implementation) for zero product benefit | Deploy the existing Python file as-is |
| ngrok / Cloudflare Tunnel to Ben's own Mac as the **primary** deployment | Directly contradicts the stated goal ("available whenever your laptop is closed") — a tunnel is still tethered to Ben's machine being on | Fly.io (primary) or a VPS (fallback) — both are genuinely always-on independent of Ben's laptop |
| Render.com free tier | Free-tier cold starts run 10-30s+ after ~15 min idle — materially worse than Fly's Machine-wake, and a slow first coach reply during a homework session is the failure mode this project can least afford | Fly.io Machines (scale-to-zero with sub-few-second wake) |
| Railway.app | No ongoing free tier since Aug 2024 (one-time trial credit only); its idle/"serverless" sleep is usage-based like Fly's but is a less mature fit for an arbitrary long-lived TCP process than Fly Machines, which were purpose-built for exactly this start/stop pattern | Fly.io Machines |

---

## Installation / config summary

```bash
# Gap 1 — one-time, before any friend installs the extension
openssl genrsa -out deploy/extension-key.pem 2048
openssl rsa -in deploy/extension-key.pem -pubout -outform DER | openssl base64 -A
# → paste output into manifest.json "key"; add deploy/extension-key.pem to .gitignore
# → update the Chrome-Extension-type and Web-application-type OAuth clients to the new stable ID

# Gap 2 — Google Classroom, same Cloud project as Docs/Drive/Calendar
# Console: enable "Google Classroom API"
# manifest.json oauth2.scopes: add
#   https://www.googleapis.com/auth/classroom.courses.readonly
#   https://www.googleapis.com/auth/classroom.coursework.me.readonly
#   https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly

# Gap 3 — deploy (existing files, unchanged)
cp deploy/fly.toml ./fly.toml
fly launch --copy-config --no-deploy
fly secrets set ANTHROPIC_API_KEY=sk-ant-... FA_TOKENS=alice:...,bob:...
fly deploy
curl https://<app>.fly.dev/health
```

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

---
*Stack research for: Focus Agent — Google OAuth stability, Canvas/Classroom API expansion, coach server hosting*
*Researched: 2026-09-17*
