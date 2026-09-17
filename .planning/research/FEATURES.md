# Feature Research

**Domain:** Focus/pomodoro apps, AI tutoring assistants, and "keep me on task" browser tools for students
**Researched:** 2026-09-17
**Confidence:** MEDIUM

**Method note:** the `gsd-tools.cjs` research-plan/cache/classify-confidence seam requires Node, which is not on PATH in this environment, so this research was done directly via web search rather than through the cached-provider seam. Confidence tiers below are assigned manually per the same hierarchy the seam would use: vendor/official product pages and Wikipedia-verified mechanics are treated as MEDIUM-HIGH; aggregated web-search summaries and app-review blogs as MEDIUM; single-source forum/anecdotal claims as LOW and flagged inline. No claim here is treated as HIGH/authoritative — verify load-bearing specifics (e.g. exact Chrome API behavior) against the docs bootstrap loaded by `agent_skills` before implementation.

This file covers only the four PLANNED (not-yet-built) features named in scope: enforced work/break cadence, one-bubble coach UI, negotiate-vs-block distraction handling, and finish/streak celebration. Everything already in PROJECT.md's "Validated" list is out of scope for this research.

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist once a product claims to do "enforced focus" or "AI coach." Missing these makes the feature feel broken or like a toy, not that the product is incomplete overall — Focus Agent's actual table stakes (portal read, Smart Start, coach boundary) are already validated.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Break that actually happens on a timer, not just a suggestion | Every serious pomodoro app (Forest, Focus To-Do, Session, Opal "Timeout" tier) at minimum times the break and returns you to work automatically — a break the app merely *suggests* is table stakes failure for anyone who's used a real pomodoro tool | LOW | Focus Agent already has the harder half built: hard planned-end with chime/amber ring/45s countdown. Extending that same state machine to a break phase is additive, not new architecture |
| Visible countdown during the break (not a blank/locked screen) | Opal, Session, Forest all show time-remaining during breaks; a break with no visible countdown reads as "frozen" or "crashed" rather than "resting" | LOW | Reuse the existing clock UI chrome for the break phase so it doesn't look like a different feature |
| Work resumes automatically when break ends, no re-click required | "Timeout" and "Deep Focus" tiers in Opal, and Session's Mac-only blocking, all auto-transition back to work; making the student manually restart breaks the "structure they can't talk their way out of" promise from PROJECT.md's Core Value | LOW-MEDIUM | This is the actual differentiator-adjacent bar: most free/cheap pomodoro extensions get this wrong and require a manual "start next pomodoro" tap |
| A single next-suggestion surface, not a menu the user has to parse | Current chatbot-UI consensus (Claude.ai, ChatGPT, Cursor-style tool framing) treats a wall of always-visible chips as dated; the pattern is "one concrete suggestion or question, not an open floor" | LOW-MEDIUM | This is the literal ask in Active requirement "One-bubble coach" — already scoped correctly against current practice |
| Distraction handling that doesn't silently do nothing | Even the softest competitors (Forest's loss-aversion tree, Freedom's block screen) give *some* signal when the student drifts; a distraction watcher that says nothing reads as absent, not gentle | LOW | Already validated/existing per PROJECT.md ("Distraction watcher (negotiates, doesn't block)") — the planned work here is refining negotiate-vs-block tradeoffs, not building detection from scratch |
| Some end-of-session acknowledgment beyond just "clock stopped" | Duolingo/Forest-style products calibrate celebration size to the size of the accomplishment; total silence at completion is the table-stakes failure mode, not the absence of confetti | LOW | Bar is low: a debrief screen with a specific, true line ("You worked 22 minutes on the lab report") clears table stakes even before any streak mechanic exists |

### Differentiators (Competitive Advantage)

Where Focus Agent can genuinely beat comparable products, given its specific constraints (school-portal-aware, tutor-not-ghostwriter, must stay legal/compliant everywhere).

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Break cadence keyed to the actual assignment/checklist state, not a blind timer | Generic pomodoro apps run 15/5 with no idea what the student is working on. Focus Agent already knows the assignment, checklist, and session stats — the break-end moment can re-anchor the student to their own checklist item ("back to Q3–5") instead of a generic "break's over" | MEDIUM | Depends on: existing checklist state + existing coach context-passing. No new data source needed, just wiring the break-end event to briefing the coach |
| Difficulty-tiered break enforcement (soft → firm → hard), matching Opal's Normal/Timeout/Deep Focus split | Not every session needs "un-skippable." A tunable enforcement level lets a first-time or low-friction session feel supportive while a student who's asked for max structure gets Cold-Turkey-grade lockout. This directly answers the "keeps it from feeling punitive" half of research question 1 | MEDIUM-HIGH | Complexity is mostly UX/config, not engineering — the underlying clock/alarm machinery already exists. Only need a settings surface + a way to persist the chosen tier per session or per student |
| One-bubble suggestion that's contextually different at each clock phase (starting, mid-work, break, near-planned-end, done) | Nobody else in this space has one coach *and* a phase-aware clock *and* assignment context simultaneously — most focus apps have no AI coach at all, and most AI tutoring chat UIs have no concept of a running clock phase. The bubble can say the single most useful thing for *this* moment ("want a 2-line recap of what you did last sitting?" right after a break) rather than a generic reopen | MEDIUM | Depends on: one-bubble UI (Active) + clock state machine (existing) + coach context passing (existing). This is a composition win, not a new subsystem |
| Negotiation that references the assignment, not just "you're off task" | A generic distraction nudge says "stay focused." Focus Agent's coach knows what's due and can negotiate with specifics ("2 checklist items left on the lab, then legitimately break") — this is a real edge over Freedom/Cold Turkey's blunt lockout and Forest's silent tree death, neither of which can reason about the actual task | LOW-MEDIUM | Already partially built (existing distraction watcher); the planned work is refining the negotiate-vs-block decision, not adding new capability |
| A finish moment that names the actual work done, not a generic badge | Research shows Duolingo-style celebration works when it's matched to real accomplishment and fails when generic/frequent. Focus Agent can say something true and specific ("Finished the lab report, 3 sittings, no missed days this week") instead of a canned animation — cheaper to build than a badge/streak system and more credible to a skeptical teen | LOW-MEDIUM | Depends on: existing debrief flow + session/stats data already collected. A "line that lands" is largely a copywriting/data-formatting problem, not a new feature |

### Anti-Features (Commonly Requested, Often Problematic)

Cross-checked against PROJECT.md's hard constraints: **legal/compliance** ("must be legal in every US state and give no school a reason to act against a student"), **privacy** (portal cookies/passwords/PII never leave the browser, nothing sent without a coach code), and **product policy** ("tutor, not ghostwriter" — never produces text a student would hand in, never gives the final answer, enforced server-side, no distributed developer-mode).

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| Hard OS/network-level site blocking (Cold Turkey/Freedom-style: lock task manager, block uninstall, prevent system time changes) | "Real" blockers do this and Focus Agent's break/work enforcement research surfaces it as the ceiling of what's possible | This is out of the extension's reach (Chrome extensions can't lock a student's OS) and, more importantly, PROJECT.md explicitly has "Blocking social media... instead of only negotiating" as an open, undecided question pending a conversation with Ben and his dad — building enforcement infrastructure ahead of that decision is scope creep into a not-yet-settled product question | Ship the negotiate-first distraction watcher (already built) and the tiered soft/firm break enforcement above; keep hard network-level blocking behind the same unresolved product conversation, don't pre-build it |
| AI-detection-evasion / "humanizer" pass on student writing | Real market demand exists — research shows students increasingly use "humanizer" tools to defeat school AI-detectors after using AI to write | Directly violates "tutor, not ghostwriter": this only has value if the coach *did* produce hand-in text, which is server-side refused (403) for every non-dev code. Any version of this is also squarely in "gives a school a reason to act against a student" — it's an admission the tool was used to produce academic-integrity-violating text | None needed — the boundary (coach never produces text a student would hand in) already structurally prevents needing this feature to exist |
| Bypass-proof / tamper-proof enforcement engineering (defeating extension-disable, DevTools, incognito, etc.) | The "students bypass blockers" research explicitly surfaces this arms race (portable browsers, Terminal kills, disabling extensions) as the norm for hard blockers | Chasing bypass-proofing is a security-engineering rabbit hole with no ceiling (Cold Turkey, one of the most locked-down tools in the category, still has documented workarounds) — for a legal-everywhere, student-consent-based tool, this is wasted effort disproportionate to value, and any anti-tamper mechanism that reaches into browser/OS internals risks tripping the same "don't bypass a school control" boundary in reverse (installing something that behaves like malware on a school-managed device) | Accept that a determined student can always defeat any browser extension; invest instead in making the *honest* path (negotiate + structure) the path of least resistance, which is what the differentiators above are for |
| Streak-shaming / loss-aversion mechanics that punish a broken streak (Forest's "tree dies and stays dead in your forest" applied harshly, or Duolingo-style streak-freeze monetization) | Loss aversion is proven to drive engagement (research: "pain of losing is roughly twice as intense as pleasure of gaining") | Research on teen-facing celebration explicitly flags that forced/frequent/mismatched celebration (and by extension, mismatched punishment) backfires — and a shame-based design pattern sits poorly next to Focus Agent's positioning as a tutor that helps rather than a system that polices; it also risks feeling punitive, which research question 1 explicitly asks the enforced-break UX to avoid | Use Forest's *gentle* version if any streak mechanic is built at all: visible but non-shaming (a paused/skipped day is just blank, not a red mark), and only ever additive language in the debrief ("no missed days this week" rather than "you broke your streak") |
| AI-generated final answers, even as a "reveal after 3 tries" or "show the answer if the student is stuck" escape hatch | Extremely commonly requested by struggling students and even well-meaning parents/tutors as a mercy valve | This is precisely the ghostwriter line PROJECT.md draws: "never gives the final answer to graded work," enforced server-side for every student code with no distributed override. Any escape hatch defeats the enforcement and reopens the exact academic-integrity liability that makes the product legally risky at schools | Escalate to worked *similar* examples, Socratic breakdown, or "here's what a partial answer/rubric looks like" — coaching patterns already in the existing Explain/Check-my-draft tools — never the actual answer |
| Detailed per-site "screen time" analytics/reports shared with parents or schools (Opal-style focus score, exportable reports) | Natural extension of session stats already collected, and a common feature in the adjacent Opal/Freedom category aimed at accountability | Anything that surfaces a student's specific browsing/distraction history to a third party (parent, school) risks becoming exactly the kind of evidence PROJECT.md's legal boundary exists to prevent ("never gives a school a reason to act against a student") — even well-intentioned parent reporting could be repurposed as disciplinary evidence, and the privacy constraint already forbids sending PII/identifying data off-device | Keep stats private to the student's own view only (already the case); if any sharing is ever considered, treat it as a full separate legal/privacy research pass, not a natural extension of the debrief feature |

## Feature Dependencies

```
Enforced work/break cadence
    └──requires──> Existing focus-clock state machine (hard planned-end, chime, alarm persistence)
                       └──requires──> Existing alarm/reload-survival logic (already validated)

One-bubble coach
    └──requires──> Existing coach chat + assignment-scoped context passing
    └──enhances──> Enforced work/break cadence (bubble can announce break-end/resume with checklist context)
    └──enhances──> Finish moment (bubble can deliver the "line that lands" inline instead of a separate modal)

Negotiate-vs-block distraction handling
    └──requires──> Existing distraction watcher (negotiation logic already built)
    └──requires-decision──> Ben's unresolved negotiate-vs-block product call (§5/§14) before any *blocking* tier is built
    └──conflicts-with──> Hard OS-level blocking anti-feature (do not build ahead of the decision)

Finish/streak celebration moment
    └──requires──> Existing debrief flow (minutes vs. guess, one-line debrief) and session stats
    └──enhances──> One-bubble coach (delivery surface)
```

### Dependency Notes

- **Enforced cadence requires the existing clock state machine:** the hard planned-end behavior (chime, amber ring, 45s countdown, alarm persistence across reload) is the load-bearing piece already validated in v0.8.20/`test-background.js`. The break phase is a new state in the same machine, not a new subsystem — this should be scheduled as an extension of existing clock code, not a parallel build.
- **One-bubble coach enhances two other Active items:** because it's a UI surface, not a capability, it's the natural delivery point for both the break-transition message and the finish-moment line. Building it *before* those two lets it absorb them cheaply; building it *after* risks two bespoke UI moments that then need retrofitting into the bubble pattern.
- **Negotiate-vs-block has a hard blocking dependency on a decision, not on code:** PROJECT.md is explicit that this is "open discussion with Ben and his dad, not decided." Any roadmap phase touching distraction handling should scope only the negotiation-refinement side until that conversation resolves — do not let "tiered enforcement" (a legitimate differentiator, scoped to the *break*, not to *website blocking*) get conflated with the undecided blocking question.
- **Finish moment requires nothing new architecturally:** it's a data-presentation problem over data Focus Agent already has (session stats, debrief, checklist completion). This is the lowest-complexity of the four and the safest first pick if sequencing needs a quick win to validate the "does a real line land with a real tester" hypothesis PROJECT.md flags as pending.

## MVP Definition

Framed against PROJECT.md's Active list — these four features are already the agreed-upon next slice, so this section maps priority *within* them rather than proposing new scope.

### Launch With (v1 of this slice)

- [ ] Enforced 15/5 (or configurable) work/break cadence with genuinely un-skippable break, auto-resume — this is the one with the clearest "structure they can't talk their way out of" promise on the line; extends existing validated clock code
- [ ] One-bubble coach replacing the chip row — directly requested, low complexity, and is the delivery surface the other two features want
- [ ] Finish moment using real, specific debrief data (no streak system yet) — cheapest of the four, high perceived-value payoff, "design pending first-tester feedback" per PROJECT.md so ship the simplest true version and let feedback drive iteration

### Add After Validation (v1.x)

- [ ] Difficulty-tiered break enforcement (soft/firm/hard) — add once the single-tier break has been tested with real students and Ben has a read on whether one enforcement level fits everyone or some sittings want it firmer
- [ ] Streak/momentum element layered onto the finish moment ("no missed days this week") — add only after the non-streak version has been tester-validated, and only in the gentle (non-shaming) form
- [ ] Break-end message anchored to checklist state via the one-bubble surface — natural v1.x once both the cadence and the bubble exist independently

### Future Consideration (v2+)

- [ ] Any *blocking* (vs. negotiating) tier for distracting sites during work — explicitly blocked on the undecided product conversation in PROJECT.md; do not schedule until that's resolved
- [ ] Any richer analytics/reporting surface beyond the student's own private stats view — explicitly out of scope per the anti-features table above; would need its own legal/privacy research pass first

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Enforced work/break cadence (single tier, auto-resume) | HIGH | LOW-MEDIUM | P1 |
| One-bubble coach | HIGH | LOW-MEDIUM | P1 |
| Finish moment (specific, non-gimmick debrief line) | MEDIUM-HIGH | LOW | P1 |
| Difficulty-tiered break enforcement | MEDIUM | MEDIUM | P2 |
| Break-end message anchored to checklist/coach context | MEDIUM | LOW (once P1s exist) | P2 |
| Gentle streak/momentum element | MEDIUM | LOW-MEDIUM | P2 |
| Blocking tier for distracting sites | UNKNOWN (pending decision) | HIGH (new detection/enforcement + policy risk) | P3 (blocked on decision) |

**Priority key:**
- P1: Must have for this slice — directly named in PROJECT.md Active list, low-to-medium cost, clear payoff
- P2: Should have, layer on once the P1 versions are tester-validated
- P3: Nice to have / explicitly gated on an unresolved product decision — do not build ahead of it

## Competitor Feature Analysis

| Feature | Forest | Opal | Cold Turkey / Freedom | Focus Agent's Approach |
|---------|--------|------|------------------------|-------------------------|
| Break enforcement | No true forced break — 25/5 is a default, user takes breaks manually; enforcement is emotional (tree dies if you leave), not structural | Three explicit tiers: Normal (cancel anytime), Timeout (increasing delay before break), Deep Focus (cannot end early, survives app deletion) | Full OS-level lock during "Frozen Turkey" sessions: blocks task manager, uninstaller, system clock changes | Structural (not emotional) enforcement reusing the already-validated hard-planned-end clock, with a tiered soft→firm model like Opal's rather than Cold Turkey's OS-level lock — matched to what a Chrome extension can legitimately do without looking like malware on a school device |
| Distraction handling during work | Passive (tree death is the only signal) | Deep Focus mode blocks apps/sites outright during a session | Outright network/app blocking, no negotiation | Negotiates using assignment context (already built); blocking tier explicitly deferred pending Ben's decision |
| AI coach / next-action surface | None | None | None | One-bubble, phase-aware, assignment-scoped — no direct competitor in this exact space combines a clock + an AI tutor + portal context |
| Completion / celebration | Tree added to a permanent forest; abandoned trees stay marked dead | Streaks, milestones, "focus score" reporting | None (utility tool, no celebration layer) | Specific, true debrief line over existing session data; gentle non-shaming version if any streak element is added later |
| Bypass posture | Not bypass-resistant by design (emotional, not technical) | Deep Focus is bypass-resistant (survives uninstall) | Extremely bypass-resistant but not bypass-proof (documented workarounds: Safari extension disable, Terminal process kill, portable browsers) | Deliberately does not chase bypass-proofing (anti-feature); relies on being legal, student-consented, and honest-path-is-easiest rather than un-defeatable |

## Sources

- [The 6 best Pomodoro timer apps | Zapier](https://zapier.com/blog/best-pomodoro-apps/)
- [Forest — The #1 Focus App for Time Well Spent](https://forestapp.cc/)
- [Forest (application) — Wikipedia](https://en.wikipedia.org/wiki/Forest_(application))
- [How Forest weaponized guilt to hook 40 million phone addicts — Medium](https://medium.com/@jashsak/how-forest-weaponized-guilt-to-hook-40-million-productivity-seekers-2a9ec6903021)
- [Opal: Screen Time Control - App Store](https://apps.apple.com/us/app/opal-screen-time-control/id1497465230)
- [Opal App Review: Is the Focus App Worth Paying For in 2026?](https://makeheadway.com/blog/opal-app-review/)
- [Opal App Review (2026): How It Works and Who It's For](https://mindsightnow.com/blogs/mindful-matters/opal-app-review)
- [Session Pomodoro Focus Timer - App Store](https://apps.apple.com/us/app/session-pomodoro-focus-timer/id1521432881)
- [The Best Pomodoro Apps for Mac in 2026 — Timing app blog](https://timingapp.com/blog/best-pomodoro-apps-for-mac/)
- [How to Configure Cold Turkey for Better Blocking and Bypass Prevention | Tech Lockdown](https://www.techlockdown.com/articles/cold-turkey-blocker)
- [Cold Turkey Blocker — official](https://getcoldturkey.com/)
- [Cold Turkey vs Freedom Website Blocker Comparison Guide](https://www.digitalzen.app/blog/cold-turkey-vs-freedom/)
- [Designing AI chat interfaces: Anatomy, patterns, pitfalls | Setproduct Blog](https://www.setproduct.com/blog/ai-chat-interface-ui-design)
- [Chatbot UI Design Patterns and Best Practices 2026](https://fuselabcreative.com/chatbot-interface-design-guide/)
- [AI Chatbot UI Design: 8 Patterns That Build User Trust](https://designpixil.com/blog/ai-chatbot-interface-design)
- [chrome.declarativeNetRequest | API | Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Chrome Extension That Blocks Websites During Focus Hours | PlugThis](https://plugthis.ai/extensions/focus-mode-blocker)
- [Streaks & Milestones: Habit-Forming Gamification (2026)](https://appstorys.com/blog-Streaks-Milestones-Habit-Gamification)
- [The Psychology Behind Duolingo's Streak Feature](https://www.justanotherpm.com/blog/the-psychology-behind-duolingos-streak-feature)
- [How to Use Meaningful Gamification in Product Design | Toptal](https://www.toptal.com/designers/gamification-design/meaningful-gamification-in-product-design)
- [How teachers can use AI homework helper tools to support student learning | SchoolAI](https://schoolai.com/blog/ai-homework-helper-tools-a-comprehensive-guide)
- [To avoid accusations of AI cheating, college students are turning to AI — NBC News](https://www.nbcnews.com/tech/internet/college-students-ai-cheating-detectors-humanizers-rcna253878)
- [The Cheating Detection Arms Race — Evelyn Learning](https://www.evelynlearning.com/blog/the-cheating-detection-arms-race-how-ai-powered-academic-integrity-tools-are-exposing-340-more-misconduct-while-students-deploy-counter-ai-to-evade-detection)
- Internal: `/Users/vanshkumar/Documents/ext_repos/focus-agent/.planning/PROJECT.md` (Active requirements, constraints, key decisions)

---
*Feature research for: Focus/pomodoro + AI tutoring browser tools for students*
*Researched: 2026-09-17*
