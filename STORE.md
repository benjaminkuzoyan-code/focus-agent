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
| `storage` | all session/streak/XP/annotation data | "Stores the user's focus sessions, streaks, and settings locally on their device. No data is transmitted." | keep |
| `activeTab` | annotator injection | "Lets the user draw highlights on the page they are currently viewing, only when they click the Annotate button." | keep |
| `tabs` | Smart Start tab parking; distraction detection during focus sessions; doc-URL capture | "During a user-started focus session, reads tab URLs to detect visits to distracting sites and offer a coaching reminder. Also organizes tabs when the user starts a work session. URLs are checked locally against a fixed list and never stored or transmitted." | keep — no narrower permission grants URL visibility for the watcher |
| `scripting` | annotator injection (with activeTab) | "Injects the drawing overlay into the current page when the user clicks Annotate." | keep |
| `alarms` | session check-ins, commitment reminders | "Schedules the user's own focus check-ins and reminder notifications." | keep |
| `notifications` | check-ins, receipts, distraction nudges | "Shows the focus reminders and check-ins the user configures." | keep |
| `sidePanel` | the main coach UI | "The extension's main interface lives in Chrome's side panel." | keep |
| Host: `*.myschoolapp.com`, `*.blackbaud.com`, `*.instructure.com`, `classroom.google.com` | portal adapters + coach overlay | "Reads the user's own assignment list from their school portal, on-device, to power prioritization and coaching. Nothing is transmitted off the device." | keep — the core single purpose |
| Host: `http://localhost:8000/*` + `adapters/demo.js` + `demo-portal/` | DEV ONLY | — | **STRIP at packaging** (scripts/package-store.sh does this) |

Single-purpose statement (store requires one): "Focus Agent helps students
see, prioritize, and actually start their schoolwork by reading their own
school portal's assignment list and coaching them through focus sessions."

Remote-code policy: compliant — no remote scripts are loaded or executed;
MV3 bundle only. AI responses are data (text), not code.

## Privacy posture (current build)

- All user data (sessions, streaks, annotations, chat history, assignment
  cache) lives in `chrome.storage.local`. Zero telemetry, zero analytics,
  zero external transmission in the store build.
- The AI bridge is localhost-only and STRIPPED from the store build. When
  the hosted backend replaces it, PRIVACY.md's "AI processing" section
  activates and the store listing + policy must be updated BEFORE shipping
  that version. The backend must be stateless (no assignment storage) to
  keep the policy honest.
- See PRIVACY.md for the user-facing draft policy. **A parent must review
  it before submission** (also needed: the $5 dev account is 18+).

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
  > 😱 Panic Button: three things due tomorrow? Get a minute-by-minute triage
  > plan with honest calls about what can wait.
  > ⏱ Focus sessions: a beautiful ring timer, streaks, and check-ins.
  > 👀 Distraction coaching: drift to YouTube mid-session and your coach
  > negotiates — it doesn't block, it reasons with you.
  > ⚔️ Boss battles: tests become bosses; doing the work drains their HP.
  > 📈 Real analytics: when you actually focus, what your distractions cost.
  > ✏️ Annotate any page. 📄 One-click doc starter with an outline ready.
  >
  > Your data stays on your device. Focus Agent helps you START your work —
  > it never does it for you.
- **Assets needed before submission:** 1280×800 screenshots (side panel
  Home, ring timer, Panic plan, portal overlay), 440×280 promo tile.
  The soft-glass UI is the visual pitch — screenshot on the demo portal.

## Submission checklist (do in order, in the fall)

1. [ ] Fall validation done: Blackbaud field mapping verified, Canvas +
       Classroom tested on real accounts, week-3 retention with classmates
2. [ ] Backend live (API key server-side, per-user rate limits) OR ship v1
       without AI features (rules-only) and add AI in an update
3. [ ] Parent: reviews PRIVACY.md, registers the $5 dev account
4. [ ] Privacy policy hosted at a public URL (GitHub Pages is fine)
5. [ ] Run scripts/package-store.sh → verify the zip has no localhost/demo/bridge
6. [ ] Screenshots + promo tile
7. [ ] Submit as UNLISTED first — install from the store link yourselves,
       verify everything, THEN flip to public
