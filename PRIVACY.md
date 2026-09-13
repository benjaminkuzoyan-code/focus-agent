# Focus Agent Privacy Policy — DRAFT for parent review

> **Not published yet.** Plain language on purpose: the people reading this
> are students and their parents. A parent must read and approve it before it
> goes on a public page or the Chrome Web Store. It describes the software as
> it actually ships today (v0.8.15), including the AI coach.

**Last updated:** [date of publication]

## The short version

Focus Agent runs in your browser. Your assignments, focus sessions, streaks,
notes and chat history are stored on your own computer. There is no account
and no database of students anywhere.

The AI coach is the one thing that leaves your computer: when you ask it
something, the bits it needs to answer are sent to a coach server and from
there to an AI provider (Anthropic), the answer comes back, and nothing is
kept on the way. Details below, with nothing left out.

## What Focus Agent reads on your computer

- **Your school portal** (Blackbaud, Canvas or Google Classroom), using the
  login already in your browser. Focus Agent never sees or asks for your
  password, and your login cookies never leave the browser. It reads your
  assignment list with the teacher's instructions, your class list and
  current grades, graded assignment scores, your class schedule, teacher-
  posted topics, and (Blackbaud) your personal calendar-feed link so the
  phone-reminders feature can use it. Teacher email addresses are not kept.
- **Web pages, PDFs and Google Docs you attach or highlight** for an
  assignment, so the coach can talk about them.
- **Screenshots you take on purpose.** The 📸 button takes a picture of the
  tab you are looking at, only when you tap it, and only the part you drag
  over. Nothing is ever captured in the background.
- **Tab addresses during a focus session you started**, checked on your
  computer against a fixed list of distracting sites so the coach can nudge
  you. This stops when the session ends and is not sent anywhere.
- **Whether your computer is idle** (mouse or keyboard activity anywhere,
  yes or no) during a session, so a forgotten timer stops itself.

## What is sent to the AI coach, and when

Only when you use a coach feature (chat, explain, check my draft, practice
test, flashcards, summarize, 📸), and only the pieces that feature needs:

- the assignment's title, instructions and due date;
- your course names and current grades as numbers, and your schedule times;
- the text of files, pages or Google Docs you attached, and your highlights;
- the screenshot you took (the cropped image itself);
- what you typed to the coach, and the recent conversation;
- your session statistics (minutes, streak).

Never your name, student id, email, teachers' contact details, your calendar
link, or any password. The coach server does not store any of this; it
forwards the request to Anthropic, returns the answer, and keeps a log line
with a time, the feature used, and an anonymous id (not your name). Anthropic
processes the request under its own terms; ask us for the current retention
details before assuming they are zero.

**Who runs the coach server.** During the pilot, the student who built Focus
Agent runs it and pays for the AI. Each pilot user gets a personal code that
can be switched off at any time. There is no coach without a code: without
one, Focus Agent works in "simple mode" (checklist, timer, streaks, no chat).

## What Focus Agent stores on your computer only

Focus sessions and timing, streaks, per-assignment notes, checklists, chat
history, practice tests, attached-file text, small thumbnails of screenshots
you took, page highlights, a cached copy of your assignment list and portal
snapshot, and, if you connect Google, a short-lived Google access token.
Everything lives in Chrome's extension storage. Uninstalling the extension
deletes it. Finished assignments have their chat, files and tests removed
automatically after 30 days.

## Google (optional)

If you tap "connect G", Focus Agent asks Google, through Google's own sign-in
screen, for permission to read and edit Google Docs, to create files it makes
itself (Drive "per-file" access, not your whole Drive), and to add calendar
events. It uses this to read the doc you're working on, create an outline
doc, format a doc (styling only; your words are never changed) and, if you
choose, add focus blocks to your calendar. You can disconnect at any time
from the extension or from your Google account settings.

## The rule that doesn't move

Focus Agent is a tutor, not a ghostwriter. It explains, checks and quizzes;
it does not write assignments, and the coach server refuses those requests
for every pilot user. A separate developer mode exists only for the person
building it, under a developer-only code.

## Students and parents

The pilot is for high-school students the developer knows personally, with
their parents aware. Focus Agent is not directed at children under 13. If a
future version is offered more widely, this policy will be updated first and,
where required, parental consent obtained before AI features are enabled.

## Your choices

- Don't enter a coach code, and nothing is ever sent anywhere.
- Ask for your code to be switched off; the coach stops immediately.
- Uninstall anytime; local data is removed with the extension.
- Clear chat, remove attached files, and delete practice tests from inside
  the extension.

## Contact

[parent-approved contact email goes here]

## Changes

If this policy changes, the "Last updated" date changes, and material
changes will be called out before they take effect.
