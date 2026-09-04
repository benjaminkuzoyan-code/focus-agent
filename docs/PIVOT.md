# Focus Agent — The Pivot (v0.6)

**Date:** 2026-08-29 · **Status:** foundation built, first two features live, more ideas incoming from Ben ("btw" queue at the bottom)

## The one-sentence change

**Before:** a focus timer that reads the assignment list.
**After:** an agent that reads the student's *whole* portal — classes, grades, schedule, syllabus, assignment instructions — and uses it to make school measurably less stressful: explaining work in plain language, checking drafts before they're turned in, planning the week, and pushing the right reminders to the phone.

## Two rules that don't move

1. **Cookies never leave the browser.** The extension calls the portal's own internal APIs *from inside the portal tab*, so the browser attaches the student's session automatically. We never see, store, or transmit a login or a cookie. There is no "give us your password" step, ever. This is what makes the product sellable to parents and defensible to schools — and it's also just the simplest architecture.
2. **Tutor, not ghostwriter.** The brain explains, questions, points, and plans. It never writes the student's sentences or gives answers. `precheck` quotes the draft and asks a leading question; it is forbidden from producing replacement text. This line is enforced in the prompts (`bridge/coach_server.py`) and it's the line teachers will accept.

## Architecture

```
portal tab (content script)             side panel / popup / worker            brain
─────────────────────────────           ─────────────────────────────          ───────────────
adapters/blackbaud.js  ──► lib/snapshot.js ──► chrome.storage.local ──►  FA.snapshotForBrain()
  fetchProfile()            buildSnapshot()      "studentSnapshot"           (privacy-stripped)
  fetchAssignments()                                                              │
  fetchClasses()   ◄── cookies ride along                                         ▼
  fetchGrades()                                                         bridge/coach_server.py
  fetchSchedule()                                                         explain / precheck /
  fetchTopics()                                                           chat / pick / panic …
  fetchICalLink()                                                         (claude -p today;
                                                                           Anthropic API later)
```

**The Student Snapshot** (`lib/snapshot.js`) is the new center of gravity. One object, built in the portal tab, cached locally:

| section | what | from |
|---|---|---|
| `student` | name, school, school year | `/api/webapp/context` |
| `classes[]` | course, block, teacher, room, **current grade**, marking period | `ParentStudentUserAcademicGroupsGet` |
| `assignments[]` | everything pending **+ full instructions text**, section id, late/missing flags | `AssignmentCenterAssignments` |
| `grades{sectionId}` | every graded item: points, %, letter, weight, late/missing | `GradeBookPerformanceAssignmentStudentList` |
| `schedule[]` | next 7 days of meetings with times, rooms, teachers | `ScheduleList` |
| `topics{sectionId}` | teacher-published units (the closest thing to a syllabus) | `sectiontopicsget/<id>/` |
| `icalLink` | the student's private calendar feed URL | `iCalScheduleGet` |

Verified live 2026-08-29 on Poly's portal: 4 graded classes, 22 assignments (16 with instructions), 27 schedule entries, 0 errors.

**What reaches the brain** is `FA.snapshotForBrain()`: courses + grades as numbers, assignment titles/descriptions (truncated), schedule times, computed risks. No names, ids, emails, teachers, raw portal objects, or the iCal token.

## Ben's feature list → what's built / what's next

| Idea (Ben) | Status | How |
|---|---|---|
| See the entire portal: grades, syllabus, classes, schedule | ✅ **built** | Snapshot + new 🎓 Classes tab (grades with trend, this week's schedule) |
| "Dumb it down" — digestible version of each assignment | ✅ **built** | 💡 **Explain** on every card: tldr, what the teacher wants, traps, 5-min first move, honest time estimate. Uses the real instructions text. |
| Grade homework before it's turned in, say what to change | ✅ **built** | 🔍 **Pre-check** on every card: paste draft → letter estimate, strengths, issues quoted from the draft with a hint each, missing requirements, next step. Never rewrites. |
| Notifications to phone | ✅ **v1 built** (zero backend) | Classes tab → "Add to Google Calendar": subscribes the phone's calendar to the portal's private iCal feed → native reminders for every class/deadline. v2 = our own push (needs a backend). |
| Auto-format Google Docs | ⏳ next | Needs a Google Cloud OAuth client (Chrome-extension type) + `drive.file` scope. Then Docs API can insert the outline/headers directly instead of the clipboard trick. **Ben must create the OAuth client** — 10 min in console.cloud.google.com; I'll do the code. |
| Automatically annotate homework | ⏳ design | Two forms: (a) annotate the *assignment* (Explain already does this in text; on-page badges could show it inline), (b) annotate the *student's document* — that's Pre-check delivered as Google Docs comments via the Docs API once OAuth exists. Comments, not edits. |
| "Autonomously reduce stress" | 🔜 | Once snapshot + brain + calendar exist: a nightly **plan** (background alarm) that reads the week, picks tonight's blocks, writes them to the calendar, and sends one message. The pieces are in place; needs the OAuth client for the write side. |

## What Ben needs to do (only he can)

1. **Reload the extension** (`chrome://extensions` ↻) and open the portal once — the snapshot builds itself. Then check the 🎓 tab.
2. **Google Cloud OAuth client** for Docs/Calendar write access (needed for doc formatting + real calendar writes):
   - console.cloud.google.com → new project "Focus Agent" → APIs & Services → enable *Google Docs API*, *Google Drive API*, *Google Calendar API*
   - OAuth consent screen: External, add yourself as test user
   - Credentials → OAuth client ID → type **Chrome Extension** → paste the extension ID from `chrome://extensions`
   - Give me the client ID (it's not a secret). I'll wire `chrome.identity` + the manifest `oauth2` block.
3. **Anthropic API key** (parents) — replaces the `claude -p` bridge with a real backend so classmates can use the brain.

## Open product questions (for the pivot talk)

- **Who pays, and for what?** Parents pay for "fewer missing assignments and less 11pm panic." Students won't pay. So the report/notification layer for parents may matter as much as the student UI — but it must be *opt-in by the student* or teens won't install it.
- **School blessing vs. stealth.** Cookie-based reading works without the school. The SKY API path (official, needs Poly IT) becomes worth it only when a school wants to roll it out to everyone. Keep both doors open.
- **Where the "explain" lives.** Side panel is fine for Ben; for classmates the on-page overlay (badge → popover on the actual assignment row) is the zero-learning-curve version.
- **Precheck scope creep.** Today it takes pasted text. Reading the student's Google Doc directly (with OAuth) is the obvious next step and also the moment it starts to look like a "cheating tool" to a teacher who doesn't read the prompt. The comment-only design is the answer; write it down in PRIVACY.md before shipping.

## btw queue (Ben's additional ideas — append here)

- _(empty — add as they come)_
