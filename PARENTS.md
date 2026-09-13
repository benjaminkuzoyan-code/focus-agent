# For Mom & Dad — what I need to run the Focus Agent pilot

Hi! This explains what I built, what I'm asking you to do, and what is (and
isn't) happening with money and data. About five minutes.

## What Focus Agent is

A Chrome extension I built that reads my own school assignment list from the
Poly portal and coaches me to actually start my homework: a focus timer that
stops when it's supposed to, a checklist per assignment, a coach I can ask
questions, practice tests, and reminders when I drift to YouTube mid-session.
It's deliberately designed to NOT do homework for me: the coach explains and
checks, it doesn't write, and that rule is enforced on the server, not just
in the app.

## What's changed since the first version of this note

The coach is now real AI, not just rules. That means some things DO leave the
computer when a student asks the coach something: the assignment text, the
files they attached, their question, and (if they use the screenshot button)
the picture they took. It goes to a small server I run, then to Anthropic
(the AI company), and the answer comes back. Nothing is stored on the way.
PRIVACY.md spells out exactly what is and isn't sent.

## What I'm asking you to do (3 things)

1. **Read PRIVACY.md** (~3 min) and tell me if anything in it is wrong or
   worrying. We also need to pick a contact email to put in it.
2. **The AI account.** The coach needs an Anthropic API key, which is a
   paid account that has to be an adult's. I'd like a spending limit set in
   that account so a mistake can't run up a bill; I'll check the total by
   hand every day the pilot runs.
3. **A place to run the coach server** (a small hosting account, about $3 a
   month). This also needs an adult's card.

Later, if we publish on the Chrome Web Store: a one-time $5 developer
account, under your Google account (Google requires 18+).

## Who the pilot is for

Four or five friends I set up in person, each with their own code I can turn
off. Their parents should know it's happening; I'll give them the same
PRIVACY.md.

## What is NOT happening

- **No money from users.** It's free. No payments, no subscriptions, no ads.
- **No accounts, no student database.** The only thing kept is a log line
  per coach request with a time, the feature used and an anonymous id.
- **No homework written by the AI.** Ever, for anyone but me in a separate
  developer mode.

## Why I want to do this

This is part of a bigger plan: learning to build and ship real products now,
so I have the skills (and a track record) when I start a company someday.
Running a real pilot, with real users and real responsibilities, is the skill
I'm practicing.

Questions? Ask me. PRIVACY.md and STORE.md have the full details.

— Ben
