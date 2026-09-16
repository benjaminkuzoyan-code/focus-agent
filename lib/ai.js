/**
 * lib/ai.js - The Coach interface. ONE swap point for the real AI.
 *
 * Everything in the app talks to FA.coach and never cares which brain is
 * behind it:
 *
 *   coach.pick(ranked)                 → {assignment, reason}
 *   coach.panicPlan(ranked, minutes)   → {blocks[], sacrifices[], pep}
 *   coach.negotiationLine(session, remainingMin, site) → string
 *   coach.breakdown(assignment)        → [subtask strings]
 *   coach.autopsy(sessions, commitments) → [insight strings]
 *
 * MockCoach (below) is rule-based, free, and runs locally — it makes every
 * feature fully testable all summer. ClaudeCoach implements the same
 * interface against the Claude API when the key lands (behind a backend
 * before any public release; the key never ships inside the extension).
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + "m" : ""}`.trim() : `${m}m`);

  class MockCoach {
    /** Choose what to work on right now, with a reason a human would give. */
    pick(ranked) {
      if (!ranked.length) return { assignment: null, reason: "Nothing pending." };
      const top = ranked[0];
      const h = FA.hoursUntil(top.dueDate);
      let reason;
      if (top.missing) reason = `Marked MISSING by your teacher — it's a zero until it's in. About ${fmtMin(top.estMin)} to clear it.`;
      else if (h < 0) reason = `Overdue. About ${fmtMin(top.estMin)} of work.`;
      else if (h < 24) reason = `Due in ${Math.round(h)}h; about ${fmtMin(top.estMin)} of work.`;
      else if (top.type === "test") reason = `Test coming up; studying earlier is more effective than the night before.`;
      else reason = `Highest urgency on the list (about ${fmtMin(top.estMin)}).`;
      return { assignment: top, reason };
    }

    /**
     * Panic Button: greedy schedule into the minutes available tonight.
     * Highest value-per-minute first; what doesn't fit gets an honest
     * sacrifice note instead of pretending everything is possible.
     */
    panicPlan(ranked, minutesAvailable) {
      const dueSoon = ranked.filter((a) => FA.hoursUntil(a.dueDate) < 36);
      const pool = dueSoon.length ? dueSoon : ranked.slice(0, 4);

      // Value density: points (weighted by urgency) per estimated minute.
      const scored = pool
        .map((a) => ({ ...a, density: (a.urgency || 1) / Math.max(a.estMin, 5) }))
        .sort((a, b) => b.density - a.density);

      const blocks = [];
      const sacrifices = [];
      let clock = new Date();
      let remaining = minutesAvailable;
      let sinceBreak = 0;

      for (const a of scored) {
        if (a.estMin <= remaining) {
          const start = new Date(clock);
          clock = new Date(clock.getTime() + a.estMin * 60000);
          blocks.push({
            start: start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
            end: clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
            title: a.title,
            course: a.course,
            minutes: a.estMin,
            note: FA.hoursUntil(a.dueDate) < 0 ? "OVERDUE — do first, do fast" : `worth ${a.points || "?"} pts`,
            assignmentId: a.id,
          });
          remaining -= a.estMin;
          sinceBreak += a.estMin;
          if (sinceBreak >= 50 && remaining > 15) {
            clock = new Date(clock.getTime() + 10 * 60000);
            blocks.push({ isBreak: true, minutes: 10, title: "Break — water, stretch, NO phone" });
            remaining -= 10;
            sinceBreak = 0;
          }
        } else if (a.estMin - remaining <= 20 && remaining >= 15) {
          // Almost fits: do a partial and say so.
          const start = new Date(clock);
          clock = new Date(clock.getTime() + remaining * 60000);
          blocks.push({
            start: start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
            end: clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
            title: a.title + " (partial — get the skeleton done)",
            course: a.course,
            minutes: remaining,
            note: "finish tomorrow morning",
            assignmentId: a.id,
          });
          remaining = 0;
        } else {
          sacrifices.push({
            title: a.title,
            course: a.course,
            why:
              (a.points || 0) <= 10
                ? `Low points (${a.points}). If something dies tonight, it's this.`
                : `No room tonight — needs ${fmtMin(a.estMin)}. Do it first thing tomorrow.`,
          });
        }
        if (remaining < 10) break;
      }

      // Anything neither scheduled nor sacrificed (time ran out before the
      // loop reached it) still deserves an honest sacrifice note — silent
      // drops are how students get surprised at midnight.
      for (const a of scored) {
        const scheduled = blocks.some((b) => b.assignmentId === a.id);
        const sacrificed = sacrifices.some((s) => s.title === a.title);
        if (!scheduled && !sacrificed) {
          sacrifices.push({
            title: a.title,
            course: a.course,
            why: `No room tonight — needs ${fmtMin(a.estMin)}. First thing tomorrow, or lobby for an extension now.`,
          });
        }
      }

      const pep =
        blocks.filter((b) => !b.isBreak).length === 0
          ? "Nothing fits — you're out of runway tonight. Sleep, wake up early, triage then."
          : `${blocks.filter((b) => !b.isBreak).length} things, ${fmtMin(minutesAvailable - remaining)} of work.`;

      return { blocks, sacrifices, pep };
    }

    /** The distraction negotiation line — persuasion with receipts, not a wall. */
    negotiationLine(session, remainingMin, site) {
      const s = site ? site.replace(/^www\./, "") : "that site";
      const lines =
        remainingMin <= 10
          ? [
              `About ${remainingMin} min left on "${session.title}".`,
              `${remainingMin} minutes left on the session.`,
            ]
          : [
              `"${session.title}" needs about ${remainingMin} more minutes at your usual pace.`,
              `Switching to ${s} mid-session typically costs about 20 minutes of refocus time. The timer is still running.`,
            ];
      return lines[Math.floor(Math.random() * lines.length)];
    }

    /** Generic task breakdown by type. (Claude will personalize this later.) */
    breakdown(assignment) {
      const plans = {
        essay: ["Brain-dump ideas (5 min, no judging)", "Pick a thesis + 3 supporting points", "Ugly first draft — speed over quality", "One revision pass", "Read it out loud, fix what sounds wrong"],
        project: ["Write down exactly what's being graded", "Split into 3-4 chunks", "Do the hardest chunk first", "Assemble + check against the rubric"],
        test: ["List the topics on the test", "Rate each 1-5 on confidence", "Study the 1s and 2s FIRST", "Self-quiz without notes", "Redo whatever you missed"],
        lab: ["Reread the procedure + your data", "Tables/graphs first", "Analysis answers", "Conclusion: claim → evidence → reasoning"],
        reading: ["Preview headings first", "Read with 1-line notes per section", "3-sentence summary at the end from memory"],
        homework: ["Do the easy problems first for momentum", "Flag the hard ones", "Return to flagged with fresh eyes", "Check answers if available"],
      };
      return plans[assignment.type] || ["Start with 10 easy minutes", "Define what 'done' looks like", "Work in 25-min blocks"];
    }

    /**
     * Structured breakdown: steps with a deliverable and a chunk-sized time.
     * Rules edition wraps the string plan; the brain edition reads the real
     * instructions. Shape: {id, text, deliverable, estMin, done, doneBy, source}.
     */
    breakdownSteps(assignment) {
      // MockCoach.prototype.breakdown explicitly: on a ClaudeCoach, this.breakdown is the
      // async brain call, and normalizeSteps(Promise) used to return [] — wiping the checklist.
      return FA.normalizeSteps(MockCoach.prototype.breakdown.call(this, assignment), assignment, "rules");
    }

    /** "smaller": split one step into 2-3 sub-steps, each ≤ the current chunk. */
    splitStep(assignment, step) {
      const half = Math.max(3, Math.round((step.estMin || 10) / 2));
      return FA.normalizeSteps(
        [
          { text: `Set up for: ${step.text}`, deliverable: "everything you need is open", estMin: Math.min(half, 5) },
          { text: `Do the first half of: ${step.text}`, deliverable: "half of it exists", estMin: half },
          { text: `Finish: ${step.text}`, deliverable: step.deliverable || "the step is done", estMin: half },
        ],
        assignment,
        "rules"
      );
    }

    /** Chat: the rules can't converse — be honest about it. */
    /** Rules fallback: restate the portal text; no model, no invention. */
    explain(assignment) {
      const desc = (assignment.description || "").trim();
      return {
        tldr: desc ? desc.split(/(?<=[.!?])\s/)[0].slice(0, 160) : `${assignment.type} for ${assignment.course}.`,
        wants: desc ? [] : ["Open the assignment in the portal — the teacher's instructions aren't in the feed."],
        traps: [],
        firstMove: MockCoach.prototype.breakdown.call(this, assignment)[0],
        estMinutes: FA.estimateMinutes(assignment, []),
        fromClaude: false,
      };
    }

    /**
     * Smart Setup, rules edition: decide what to open/prepare from the
     * teacher's own links + this class's topics. No model, no invention —
     * only resources the panel handed us.
     */
    setup(assignment, resources = {}) {
      const links = resources.links || [];
      const topics = resources.topics || [];
      const desc = String(resources.description || assignment.description || "");
      const opens = [];

      // Teacher links: open them ALL (capped) — attached files and links are
      // in the assignment for a reason. resolveOpens re-adds any we skip.
      links.slice(0, 6).forEach((l, i) => opens.push({ kind: "link", i, why: l.attached ? "attached to the assignment" : l.text || "linked in instructions" }));

      // Topic/module: one that's named in the instructions, else the only one.
      if (opens.length < 7 && topics.length) {
        const lower = desc.toLowerCase();
        let ti = topics.findIndex((t) => t.name && t.name.length > 3 && lower.includes(t.name.toLowerCase()));
        if (ti < 0 && topics.length === 1 && /module|topic|class page|resources/i.test(desc)) ti = 0;
        if (ti >= 0) opens.push({ kind: "topic", i: ti, why: "the class module" });
      }

      const wantsDoc = (assignment.type === "essay" || assignment.type === "project") && Boolean(resources.googleConnected);
      const firstLine = desc.split("\n").map((x) => x.trim()).filter(Boolean)[0] || "";
      // Confidence: without instructions we're guessing, and the work view
      // should open with a question instead of a plan.
      const hasDesc = desc.trim().length > 20;
      return {
        opens,
        doc: wantsDoc,
        gather: [],
        focus: (firstLine || `${assignment.type} for ${assignment.course}`).slice(0, 140),
        firstMove: MockCoach.prototype.breakdown.call(this, assignment)[0],
        confidence: hasDesc ? 0.85 : 0.35,
        missing: hasDesc ? [] : ["what the teacher actually asked for — the instructions aren't in the feed"],
        fromClaude: false,
      };
    }

    /** Rules fallback: a checklist, since there's no model to read the draft. */
    precheck(assignment, draft) {
      const words = String(draft || "").trim().split(/\s+/).filter(Boolean).length;
      return {
        grade: "?",
        strengths: [],
        issues: [],
        missing: [
          "Simple mode can't really grade a draft — with the smarter coach on (⚙ → Coach) you get a real read-through.",
          `Reread the instructions: does every requirement show up in your ${words} words?`,
          "Read it out loud once. Anything you stumble on, the teacher will too.",
        ],
        nextStep: "Open the assignment text side by side with your draft and tick off each requirement.",
        fromClaude: false,
      };
    }

    /* ---- selection toolbar (rules editions) ---- */

    /** Summarize a passage without a model: first sentence of each paragraph, capped. */
    summarize(text) {
      const paras = String(text || "").split(/\n{2,}|\n(?=\s*[-•*\d])/).map((x) => x.trim()).filter((x) => x.length > 30);
      const firsts = (paras.length ? paras : [String(text || "")]).map((x) => x.split(/(?<=[.!?])\s/)[0].slice(0, 180));
      const bullets = [...new Set(firsts)].slice(0, 4);
      return { summary: bullets.map((b) => "• " + b).join("\n") + "\n(simple mode: these are just the first sentences of each paragraph, not a real summary.)", fromClaude: false };
    }

    /** The question the student answers in their own note — never the answer. */
    annotateQuestion(quote) {
      const q = String(quote || "");
      const pool = /\d{3,}|percent|%/.test(q)
        ? ["What is this number evidence FOR?", "Who measured this, and would they have a reason to shade it?"]
        : /"|“|said|argued|claimed/.test(q)
          ? ["Who is speaking here, and what do they want the reader to believe?", "Do you buy this claim? What would change your mind?"]
          : q.length > 400
            ? ["In one sentence: what is this passage saying?", "Which sentence here matters most, and why?"]
            : ["Why did the author put this here?", "What does this connect to earlier in the reading?", "In your own words: what is this saying?"];
      return { question: pool[Math.floor(Math.random() * pool.length)], fromClaude: false };
    }

    askPassage() {
      return { reply: "The coach is in simple mode right now, so I can't answer that — try again in a minute.", fromClaude: false };
    }

    /* ---- study mode (rules editions) ---- */

    /** Cards from the student's own highlights (quote → note) and definition-shaped sentences. */
    flashcards(assignment, files = []) {
      const cards = [];
      for (const f of files) {
        for (const h of f.highlights || []) {
          if (h.quote && h.note) cards.push({ q: h.note.length < h.quote.length ? h.note : `What does this refer to: “${h.quote.slice(0, 90)}”?`, a: h.note.length < h.quote.length ? h.quote.slice(0, 200) : h.note.slice(0, 200) });
        }
        const sentences = String(f.text || "").split(/(?<=[.!?])\s+/).filter((s) => s.length > 30 && s.length < 220);
        for (const s of sentences) {
          const m = s.match(/^([A-Z][\w\s'-]{2,40}?)\s+(is|are|was|were|means|refers to)\s+(.{15,160})[.!?]$/);
          if (m) cards.push({ q: `What ${m[2] === "are" || m[2] === "were" ? "are" : "is"} ${m[1].trim()}?`, a: m[3].trim() });
          if (cards.length >= 16) break;
        }
      }
      const seen = new Set();
      const uniq = cards.filter((c) => (seen.has(c.q) ? false : seen.add(c.q))).slice(0, 16);
      return { cards: uniq, fromClaude: false, error: uniq.length ? "" : "No highlights or definition-style sentences to build cards from yet — highlight the key lines in the reading first, or turn on the smarter coach (⚙ → Coach)." };
    }

    /** Spread topics over the days until the test: 20-min sessions, hardest first is the brain's job. */
    studyPlan(assignment, { topics = [] } = {}) {
      const h = FA.hoursUntil(assignment.dueDate);
      if (!assignment.dueDate || h < 0) return { sessions: [], fromClaude: false, error: "No upcoming due date on this test." };
      const days = Math.max(1, Math.min(10, Math.floor(h / 24)));
      const names = topics.map((t) => t.name).filter(Boolean);
      const units = names.length ? names : ["review notes", "redo homework problems", "self-quiz without notes"];
      const sessions = [];
      for (let d = 0; d < days; d++) {
        const date = new Date(Date.now() + d * 86400000);
        const day = d === 0 ? "today" : date.toLocaleDateString(undefined, { weekday: "short" });
        const unit = units[d % units.length];
        const last = d === days - 1;
        sessions.push({ day, text: last ? "full self-quiz, no notes — redo everything you missed" : `${unit}: reread notes, then 5 problems/questions from memory`, deliverable: last ? "score + list of misses" : "one page of notes from memory", estMin: 20 });
      }
      return { sessions, fromClaude: false, note: `Rules plan: ${days} day${days > 1 ? "s" : ""} until the test.` };
    }

    readScreen() {
      return { fromClaude: false, error: "The coach is in simple mode right now — it can't look at your screen. Try again in a minute." };
    }
    readPage() {
      return { text: "", figures: [], fromClaude: false, error: "simple mode — can't read image-only pages" };
    }
    videoSummary() {
      return { fromClaude: false, error: "The coach is in simple mode right now — it can't watch videos. Try again in a minute." };
    }

    /**
     * Rules practice test: the flashcard rules give q/a pairs; pairs become
     * short-answer questions, and when there are enough of them the other
     * answers make multiple-choice distractors. No brain → no tf questions.
     */
    practiceTest(assignment, { files = [], count = 10 } = {}) {
      const cards = this.flashcards(assignment, files).cards || [];
      const qs = [];
      cards.slice(0, count).forEach((c, i) => {
        const others = cards.filter((o) => o !== c).map((o) => o.a).slice(0, 3);
        if (others.length === 3 && i % 2 === 0) {
          const choices = [c.a, ...others];
          // Fisher–Yates so the right answer isn't always first.
          for (let k = choices.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [choices[k], choices[j]] = [choices[j], choices[k]]; }
          qs.push({ type: "mcq", question: c.q, choices, answer: choices.indexOf(c.a), explanation: "" });
        } else {
          qs.push({ type: "short", question: c.q, answer: c.a, accept: [], explanation: "" });
        }
      });
      return {
        title: "Self-check",
        questions: FA.normalizeQuestions(qs),
        fromClaude: false,
        error: qs.length ? "" : "No highlights or definition-style sentences to build a test from yet — highlight key lines in the reading first, or turn on the smarter coach (⚙ → Coach).",
      };
    }

    voiceProfile() {
      return null; // rules edition: FA.voice falls back to its stats profile
    }

    /* ---- Ben's build (rules can't do the work; say so) ---- */
    writeStep() {
      return { text: "", fromClaude: false, error: "The coach is in simple mode right now — try again in a minute." };
    }
    answerAll() {
      return { text: "", fromClaude: false, error: "The coach is in simple mode right now — try again in a minute." };
    }
    readPhoto() {
      return { legible: false, stepsDone: [], feedback: "The coach is in simple mode right now — try the photo again in a minute.", fromClaude: false };
    }
    editDoc() {
      return { ops: [], summary: "", fromClaude: false, error: "The coach is in simple mode right now — try again in a minute." };
    }

    chat(_messages, _context) {
      return {
        reply:
          "I'm in simple mode right now: I can still break work into steps, run the clock and keep your streak, " +
          "but chat needs the smarter coach. If you were given a coach link + code, check they're pasted under ⚙ → Coach.",
      };
    }

    /** Session debrief: template line from the numbers. */
    debrief(record) {
      if (!record) return { line: "Session logged." };
      const clean = (record.distractions || 0) === 0;
      return {
        line: `${record.actualMin} min on ${record.course || "it"}${clean ? ", zero distractions — clean session" : ""}. Logged. 🔥`,
      };
    }

    /** Procrastination Autopsy: honest patterns from real logged data. */
    autopsy(sessions, commitments) {
      const insights = [];
      if (sessions.length < 3) {
        insights.push("Not enough sessions logged yet for real patterns. Three more and the mirror gets interesting.");
        return insights;
      }

      // Average start hour
      const startHours = sessions.map((s) => new Date(s.startedAt).getHours() + new Date(s.startedAt).getMinutes() / 60);
      const avgStart = startHours.reduce((a, b) => a + b, 0) / startHours.length;
      const hh = Math.floor(avgStart);
      const mm = String(Math.round((avgStart - hh) * 60)).padStart(2, "0");
      insights.push(`You start focusing around ${((hh + 11) % 12) + 1}:${mm} ${hh >= 12 ? "PM" : "AM"} on average. ${avgStart >= 21 ? "That's tired-brain territory — the same work costs ~2x the time after 9 PM." : "Solid — that's prime brain time."}`);

      // Planned vs actual
      const withPlan = sessions.filter((s) => s.plannedMin > 0);
      if (withPlan.length >= 3) {
        const ratio = withPlan.reduce((a, s) => a + s.actualMin / s.plannedMin, 0) / withPlan.length;
        if (ratio > 1.3) insights.push(`Tasks run ~${Math.round((ratio - 1) * 100)}% longer than you plan. Not a flaw — just plan with the real number.`);
        else if (ratio < 0.7) insights.push(`You finish faster than planned (~${Math.round((1 - ratio) * 100)}% under). You can afford to schedule more per night.`);
        else insights.push("Your time estimates are honest — planned vs actual is tight. That's rare.");
      }

      // Distractions
      const totalDistractions = sessions.reduce((a, s) => a + (s.distractions || 0), 0);
      if (totalDistractions > 0) {
        insights.push(`${totalDistractions} logged distraction${totalDistractions > 1 ? "s" : ""} across ${sessions.length} sessions. Each one costs ~20 min of refocus — that's real homework time.`);
      }

      // Best day
      const byDay = {};
      for (const s of sessions) {
        const d = new Date(s.endedAt).toLocaleDateString(undefined, { weekday: "long" });
        byDay[d] = (byDay[d] || 0) + s.actualMin;
      }
      const best = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
      if (best) insights.push(`${best[0]} is your power day (${Math.round(best[1])} focused min). Schedule the hard stuff there.`);

      // Commitments
      const resolved = commitments.filter((c) => c.keptAt || c.missedAt);
      if (resolved.length >= 2) {
        const kept = resolved.filter((c) => c.keptAt).length;
        insights.push(`Commitments kept: ${kept}/${resolved.length}. ${kept / resolved.length >= 0.7 ? "Your word means something — keep that." : "The gap between what you say and do is where the stress lives."}`);
      }

      // The dread ledger: every recorded dread-session is one you FINISHED —
      // the emotional data proving the dread was lying.
      const dreaded = sessions.filter((s) => s.mood === "dread");
      if (dreaded.length >= 2) {
        const avgDread = Math.round(dreaded.reduce((a, s) => a + s.actualMin, 0) / dreaded.length);
        insights.push(
          `${dreaded.length} sessions you went into dreading — and you finished every one (avg ${avgDread} min). The dread keeps lying to you.`
        );
      }

      return insights;
    }
  }

  /**
   * ClaudeCoach - the real brain, via the local bridge server
   * (bridge/coach_server.py), which runs headless Claude Code with Ben's
   * existing login — no API key needed. Every method falls back to
   * MockCoach's rules on any failure, so the extension never breaks when
   * the bridge isn't running. negotiationLine stays rule-based (it has to
   * be instant).
   */
  // 127.0.0.1 explicitly, not "localhost": Chrome can resolve localhost to
  // IPv6 ::1, and the bridge listens on IPv4 only.
  const DEFAULT_BRIDGE = "http://127.0.0.1:8000";
  let bridgeCfg = { url: DEFAULT_BRIDGE, token: "", local: true };

  /**
   * Where the bridge is + the access code, from settings (⚙ → coach server).
   * Read straight from chrome.storage rather than FA.store: content scripts
   * load this file without storage.js. Blank URL = the bridge on this
   * computer; a hosted bridge needs the code Ben handed out.
   */
  async function loadBridgeConfig() {
    try {
      const { settings } = await chrome.storage.local.get("settings");
      const url = String(settings?.bridgeUrl || "").trim().replace(/\/+$/, "");
      bridgeCfg = { url: url || DEFAULT_BRIDGE, token: String(settings?.bridgeToken || "").trim(), local: !url };
    } catch {
      bridgeCfg = { url: DEFAULT_BRIDGE, token: "", local: true };
    }
    return bridgeCfg;
  }
  FA.bridgeConfig = loadBridgeConfig;

  function bridgeHeaders() {
    const h = { "Content-Type": "application/json" };
    if (bridgeCfg.token) h["X-FA-Token"] = bridgeCfg.token;
    return h;
  }

  async function bridgeCall(method, payload, timeoutMs = 60000) {
    await loadBridgeConfig();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${bridgeCfg.url}/coach`, {
        method: "POST",
        headers: bridgeHeaders(),
        body: JSON.stringify({ method, payload }),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "bridge error");
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Compact assignment payload — the brain doesn't need `raw`. */
  const slim = (a) => ({
    id: a.id,
    title: a.title,
    course: a.course,
    type: a.type,
    estMin: a.estMin,
    points: a.points,
    hoursLeft: Math.round(FA.hoursUntil(a.dueDate)),
    missing: a.missing || undefined,   // teacher-flagged: a zero in the gradebook right now
    overdue: FA.isBehind?.(a) || undefined,
  });

  const fmtT = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  class ClaudeCoach extends MockCoach {
    async pick(ranked) {
      if (!ranked.length) return super.pick(ranked);
      try {
        const r = await bridgeCall("pick", { assignments: ranked.slice(0, 8).map(slim) });
        const assignment = ranked.find((a) => a.id === r.id) || ranked[0];
        return { assignment, reason: String(r.reason || "").slice(0, 220) };
      } catch {
        return super.pick(ranked);
      }
    }

    async panicPlan(ranked, minutesAvailable) {
      try {
        const dueSoon = ranked.filter((a) => FA.hoursUntil(a.dueDate) < 36).slice(0, 8);
        const r = await bridgeCall("panicPlan", {
          minutesAvailable,
          assignments: (dueSoon.length ? dueSoon : ranked.slice(0, 6)).map(slim),
        });

        const blocks = [];
        let clock = new Date();
        for (const o of r.order || []) {
          const a = ranked.find((x) => x.id === o.id);
          if (!a) continue;
          const mins = Math.max(5, Math.min(Number(o.minutes) || a.estMin, minutesAvailable));
          const start = new Date(clock);
          clock = new Date(clock.getTime() + mins * 60000);
          blocks.push({
            start: fmtT(start), end: fmtT(clock),
            title: a.title, course: a.course, minutes: mins,
            note: String(o.note || "").slice(0, 80),
            assignmentId: a.id,
          });
        }
        const sacrifices = (r.sacrifices || [])
          .map((s) => {
            const a = ranked.find((x) => x.id === s.id);
            return a ? { title: a.title, course: a.course, why: String(s.why || "").slice(0, 120) } : null;
          })
          .filter(Boolean);

        if (!blocks.length) throw new Error("empty plan");
        return { blocks, sacrifices, pep: String(r.pep || "").slice(0, 160) };
      } catch {
        return super.panicPlan(ranked, minutesAvailable);
      }
    }

    async breakdown(assignment) {
      try {
        const r = await bridgeCall("breakdown", { assignment: slim(assignment) });
        if (Array.isArray(r.steps) && r.steps.length) {
          return r.steps.slice(0, 6).map((s) => String(s).slice(0, 140));
        }
        throw new Error("no steps");
      } catch {
        return super.breakdown(assignment);
      }
    }

    async breakdownSteps(assignment) {
      try {
        const r = await bridgeCall("breakdownSteps", {
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 3000) },
        });
        if (Array.isArray(r.steps) && r.steps.length) return FA.normalizeSteps(r.steps.slice(0, 8), assignment, "claude");
        throw new Error("no steps");
      } catch {
        return super.breakdownSteps(assignment);
      }
    }

    async splitStep(assignment, step) {
      try {
        const r = await bridgeCall("splitStep", {
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 2000) },
          step: { text: step.text, deliverable: step.deliverable, estMin: step.estMin },
        });
        if (Array.isArray(r.steps) && r.steps.length >= 2) return FA.normalizeSteps(r.steps.slice(0, 3), assignment, "claude");
        throw new Error("no split");
      } catch {
        return super.splitStep(assignment, step);
      }
    }

    async chat(messages, context = {}) {
      try {
        const voice = context.devMode || context.mode === "answer" ? await FA.voice?.forBrain?.().catch(() => null) : null;
        const r = await bridgeCall(
          "chat",
          {
            voice,
            // The assignment being worked right now + its checklist, so the
            // coach talks about THIS task, not the whole week.
            focus: context.focus
              ? {
                  assignment: { ...slim(context.focus.assignment), description: String(context.focus.assignment.description || "").slice(0, 3000) },
                  steps: (context.focus.steps || []).map((s) => ({ text: s.text, done: Boolean(s.done), estMin: s.estMin })),
                  elapsedMin: context.focus.elapsedMin || 0,
                }
              : null,
            messages: (messages || []).slice(-20).map((m) => ({
              role: m.role,
              text: String(m.text || "").slice(0, 1500),
            })),
            mode: context.mode || "tutor",
            files: (context.files || []).map((f) => ({ title: f.title, kind: f.kind, text: String(f.text || "").slice(0, 14000), truncated: Boolean(f.truncated), highlights: f.highlights || [] })),
            devMode: Boolean(context.devMode),
            quiz: Boolean(context.quiz),
            googleConnected: Boolean(context.googleConnected),
            docTarget: context.docTarget || null,
            assignments: (context.ranked || []).slice(0, 8).map(slim),
            stats: context.stats || {},
            context: context.brain || null, // FA.snapshotForBrain() output, privacy-stripped
            doc: context.doc || null,       // the Google Doc open in the active tab, if any
            docNote: context.docNote || "",

          },
          150000 // conversations deserve the long timeout
        );
        // Backstop only — the prompt's LENGTH CAP is the real limit. Dev-mode
        // essays stay whole; a tutor reply past ~1000 words means the cap was ignored.
        const cap = context.devMode ? 40000 : 6000;
        let reply = String(r.reply || "");
        if (reply.length > cap) reply = reply.slice(0, cap).replace(/\s+\S*$/, "") + " …";
        if (reply) return { reply };
        throw new Error("empty reply");
      } catch (e) {
        return {
          reply: "The assistant call failed (" + (e.message || "unknown") + "). Try again in a moment.",
        };
      }
    }

    async explain(assignment, context = null) {
      try {
        const r = await bridgeCall("explain", {
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 3000) },
          context,
        }, 60000);
        if (!r.tldr) throw new Error("no tldr");
        return {
          tldr: String(r.tldr).slice(0, 200),
          wants: (r.wants || []).slice(0, 4).map((x) => String(x).slice(0, 140)),
          traps: (r.traps || []).slice(0, 3).map((x) => String(x).slice(0, 140)),
          firstMove: String(r.firstMove || "").slice(0, 200),
          estMinutes: Number(r.estMinutes) || FA.estimateMinutes(assignment, []),
          fromClaude: true,
        };
      } catch {
        return super.explain(assignment);
      }
    }

    /**
     * Smart Setup, brain edition: the model reads the instructions and picks
     * from a NUMBERED inventory of safe resources — it can never invent a
     * URL, only choose indices we handed it. Falls back to rules on any
     * failure or out-of-range reply.
     */
    async setup(assignment, resources = {}) {
      const links = resources.links || [];
      const topics = resources.topics || [];
      try {
        const settings = await FA.store.getSettings();
        const r = await bridgeCall("setup", {
          assignment: { ...slim(assignment), description: String(resources.description || assignment.description || "").slice(0, 3000) },
          resources: {
            links: links.map((l, i) => ({ i, text: l.text })),
            topics: topics.map((t, i) => ({ i, name: t.name, desc: String(t.description || "").slice(0, 200) })),
            googleConnected: Boolean(resources.googleConnected),
          },
          mode: settings.mode || "tutor",
        }, 60000);

        // Validate hard: only indices that exist, capped, known kinds.
        const opens = (Array.isArray(r.opens) ? r.opens : [])
          .filter((o) => (o.kind === "link" && links[o.i]) || (o.kind === "topic" && topics[o.i]))
          .slice(0, 8)
          .map((o) => ({ kind: o.kind, i: Number(o.i), why: String(o.why || "").slice(0, 60) }));
        return {
          opens,
          doc: Boolean(r.doc) && Boolean(resources.googleConnected),
          gather: (Array.isArray(r.gather) ? r.gather : []).slice(0, 4).map((g) => String(g).slice(0, 80)),
          focus: String(r.focus || "").slice(0, 140) || super.setup(assignment, resources).focus,
          firstMove: String(r.firstMove || "").slice(0, 140) || MockCoach.prototype.breakdown.call(this, assignment)[0],
          confidence: Math.max(0, Math.min(1, Number(r.confidence ?? 0.8))),
          missing: (Array.isArray(r.missing) ? r.missing : []).slice(0, 2).map((m) => String(m).slice(0, 120)),
          fromClaude: true,
        };
      } catch {
        return super.setup(assignment, resources);
      }
    }

    async precheck(assignment, draft, rubric = "") {
      try {
        const r = await bridgeCall("precheck", {
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 3000) },
          draft: String(draft || "").slice(0, 12000),
          rubric: String(rubric || "").slice(0, 2000),
        }, 90000);
        if (!Array.isArray(r.issues)) throw new Error("no issues array");
        return {
          grade: String(r.grade || "?").slice(0, 4),
          strengths: (r.strengths || []).slice(0, 3).map((x) => String(x).slice(0, 160)),
          issues: r.issues.slice(0, 5).map((i) => ({
            quote: String(i.quote || "").slice(0, 120),
            problem: String(i.problem || "").slice(0, 200),
            hint: String(i.hint || "").slice(0, 200),
          })),
          missing: (r.missing || []).slice(0, 5).map((x) => String(x).slice(0, 160)),
          nextStep: String(r.nextStep || "").slice(0, 200),
          fromClaude: true,
        };
      } catch {
        return super.precheck(assignment, draft);
      }
    }

    /* ---- selection toolbar (brain editions) ---- */
    async summarize(text, meta = {}) {
      try {
        const r = await bridgeCall("summarize", { text: String(text || "").slice(0, 12000), title: meta.title || "" }, 60000);
        if (!r.summary) throw new Error("no summary");
        return { summary: String(r.summary).slice(0, 2500), fromClaude: true };
      } catch {
        return super.summarize(text);
      }
    }

    async annotateQuestion(quote, meta = {}) {
      try {
        const r = await bridgeCall("annotateQuestion", { quote: String(quote || "").slice(0, 1500), title: meta.title || "", url: meta.url || "" }, 45000);
        if (!r.question) throw new Error("no question");
        return { question: String(r.question).slice(0, 200), fromClaude: true };
      } catch {
        return super.annotateQuestion(quote);
      }
    }

    async askPassage(quote, question, meta = {}) {
      try {
        const settings = await FA.store.getSettings();
        const r = await bridgeCall("askPassage", {
          quote: String(quote || "").slice(0, 4000),
          question: String(question || "").slice(0, 500),
          title: meta.title || "",
          url: meta.url || "",
          mode: settings.mode || "tutor",
        }, 90000);
        if (!r.reply) throw new Error("no reply");
        return { reply: String(r.reply).slice(0, 4000), fromClaude: true };
      } catch {
        return super.askPassage();
      }
    }

    /* ---- study mode ---- */
    async flashcards(assignment, files = []) {
      try {
        const r = await bridgeCall("flashcards", {
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 2000) },
          files: files.map((f) => ({ title: f.title, text: String(f.text || "").slice(0, 8000), highlights: (f.highlights || []).slice(0, 30) })),
        }, 120000);
        const cards = (Array.isArray(r.cards) ? r.cards : []).filter((c) => c.q && c.a).slice(0, 30).map((c) => ({ q: String(c.q).slice(0, 200), a: String(c.a).slice(0, 300) }));
        if (!cards.length) throw new Error("no cards");
        return { cards, fromClaude: true };
      } catch (e) {
        const rules = super.flashcards(assignment, files);
        return rules.cards.length ? rules : { ...rules, error: `Couldn't make cards (${e.message}). ${rules.error || ""}` };
      }
    }

    async studyPlan(assignment, { topics = [], files = [] } = {}) {
      try {
        const r = await bridgeCall("studyPlan", {
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 2000), dueDate: assignment.dueDate },
          topics: topics.slice(0, 20).map((t) => ({ name: t.name, desc: String(t.description || "").slice(0, 160) })),
          files: files.map((f) => ({ title: f.title, text: String(f.text || "").slice(0, 4000) })),
          now: new Date().toString(),
        }, 120000);
        const sessions = (Array.isArray(r.sessions) ? r.sessions : []).slice(0, 14).map((s) => ({ day: String(s.day || "").slice(0, 20), text: String(s.text || "").slice(0, 160), deliverable: String(s.deliverable || "").slice(0, 100), estMin: Math.max(10, Math.min(45, Number(s.estMin) || 20)) }));
        if (!sessions.length) throw new Error("no sessions");
        return { sessions, note: String(r.note || "").slice(0, 160), fromClaude: true };
      } catch {
        return super.studyPlan(assignment, { topics });
      }
    }

    /**
     * Structured practice test from the files + highlights. `avoid` = prompts
     * already on the student's test (for "more questions"), `topic` narrows
     * it, `harder` asks for application-level questions.
     */
    async practiceTest(assignment, { files = [], count = 10, types = [], topic = "", avoid = [], harder = false } = {}) {
      try {
        const r = await bridgeCall("practiceTest", {
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 2000) },
          files: files.map((f) => ({ title: f.title, text: String(f.text || "").slice(0, 8000), highlights: (f.highlights || []).slice(0, 30) })),
          count: Math.max(3, Math.min(25, Number(count) || 10)),
          types: types.slice(0, 4),
          topic: String(topic || "").slice(0, 200),
          avoid: avoid.slice(0, 60).map((a) => String(a).slice(0, 160)),
          harder: Boolean(harder),
        }, 150000);
        const questions = FA.normalizeQuestions(r.questions).slice(0, 25);
        if (!questions.length) throw new Error("no usable questions");
        return { title: String(r.title || "Practice test").slice(0, 60), questions, fromClaude: true };
      } catch (e) {
        const rules = super.practiceTest(assignment, { files, count });
        return rules.questions.length ? rules : { ...rules, error: `Couldn't build the test (${e.message}). ${rules.error || ""}` };
      }
    }

    async voiceProfile(samples, guide = "") {
      try {
        const r = await bridgeCall("voiceProfile", {
          samples: samples.slice(-8).map((s) => ({ title: s.title, text: String(s.text || "").slice(0, 6000) })),
          guide: String(guide || "").slice(0, 3000),
        }, 120000);
        if (!r.profile) throw new Error("no profile");
        return {
          profile: String(r.profile).slice(0, 900),
          traits: (r.traits || []).slice(0, 12).map((x) => String(x).slice(0, 100)),
          avoid: (r.avoid || []).slice(0, 8).map((x) => String(x).slice(0, 80)),
          builtAt: Date.now(),
          sampleIds: samples.map((s) => s.id),
          fromClaude: true,
        };
      } catch {
        return null;
      }
    }

    /* ---- Ben's build ---- */
    async writeStep(assignment, step, steps = [], docText = "") {
      try {
        const voice = await FA.voice?.forBrain?.().catch(() => null);
        const r = await bridgeCall("writeStep", {
          voice,
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 4000) },
          step: { text: step.text, deliverable: step.deliverable, estMin: step.estMin },
          steps: steps.map((s) => ({ text: s.text, done: Boolean(s.done) })),
          docText: String(docText || "").slice(0, 12000),
        }, 150000);
        if (!r.text) throw new Error("empty");
        return { text: String(r.text).slice(0, 20000), fromClaude: true };
      } catch (e) {
        return { ...super.writeStep(), error: `Couldn't write it (${e.message}).` };
      }
    }

    async answerAll(assignment, extra = "") {
      try {
        const voice = await FA.voice?.forBrain?.().catch(() => null);
        const r = await bridgeCall("answerAll", {
          voice,
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 6000) },
          extra: String(extra || "").slice(0, 8000),
        }, 150000);
        if (!r.text) throw new Error("empty");
        return { text: String(r.text).slice(0, 20000), fromClaude: true };
      } catch (e) {
        return { ...super.answerAll(), error: `Couldn't answer (${e.message}).` };
      }
    }

    async editDoc(assignment, outline, instruction) {
      try {
        const voice = await FA.voice?.forBrain?.().catch(() => null);
        const r = await bridgeCall("editDoc", {
          voice,
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 3000) },
          outline: (outline || []).slice(0, 400),
          instruction: String(instruction || "").slice(0, 800),
        }, 150000);
        if (!Array.isArray(r.ops)) throw new Error("no ops");
        return { ops: r.ops.slice(0, 60), summary: String(r.summary || "").slice(0, 160), fromClaude: true };
      } catch (e) {
        return { ...super.editDoc(), error: `Couldn't edit (${e.message}).` };
      }
    }

    async readPhoto(assignment, steps, imageDataUrl) {
      try {
        const r = await bridgeCall("readPhoto", {
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 2000) },
          steps: steps.map((s, i) => ({ i, text: s.text, deliverable: s.deliverable, done: Boolean(s.done) })),
          imageDataUrl,
        }, 150000);
        return {
          legible: Boolean(r.legible),
          stepsDone: (Array.isArray(r.stepsDone) ? r.stepsDone : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < steps.length),
          feedback: String(r.feedback || "").slice(0, 300),
          fromClaude: true,
        };
      } catch {
        return super.readPhoto();
      }
    }

    /**
     * Screenshot of the page → page overview (no question) or an answer about
     * what's visible (question). Also returns the transcribed text so the
     * page can join the assignment's files.
     */
    /**
     * Read an image of what the student is looking at: a screenshot (source
     * "screen") or a photo they uploaded of a book page / worksheet / their
     * notes (source "photo"). The server applies the annotation rule (spec
     * §10): summary + key ideas + quotes when annotating isn't the graded
     * work, orientation only when it is.
     */
    async readScreen(assignment, imageDataUrl, { question = "", page = {}, source = "screen" } = {}) {
      try {
        const r = await bridgeCall("readScreen", {
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 1500) },
          page: { title: String(page.title || "").slice(0, 120), host: String(page.host || "").slice(0, 80) },
          question: String(question || "").slice(0, 400),
          source: source === "photo" ? "photo" : "screen",
          imageDataUrl,
        }, 150000);
        const strs = (v, n, cap) => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim().slice(0, cap)).filter(Boolean).slice(0, n);
        return {
          what: String(r.what || "").slice(0, 200),
          summary: String(r.summary || "").slice(0, 900),
          keyIdeas: strs(r.keyIdeas, 8, 220),
          lookFor: strs(r.lookFor, 5, 200),
          questions: strs(r.questions, 12, 220),
          quotes: strs(r.quotes, 6, 220),
          annotationGraded: Boolean(r.annotationGraded),
          why: String(r.why || "").slice(0, 200),
          answer: String(r.answer || "").slice(0, 1200),
          text: String(r.text || "").slice(0, 4000),
          fromClaude: true,
        };
      } catch (e) {
        return { ...super.readScreen(), error: `Couldn't read the screen (${e.message}).` };
      }
    }

    /** One image-only PDF page → transcription + figure descriptions (spec §11.1). */
    async readPage(assignment, imageDataUrl, { page = 0, pages = 0, title = "" } = {}) {
      try {
        const r = await bridgeCall("readPage", {
          assignment: slim(assignment),
          page: { title: String(title || "").slice(0, 120), n: Number(page) || 0, of: Number(pages) || 0 },
          imageDataUrl,
        }, 150000);
        const strs = (v, n, cap) => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim().slice(0, cap)).filter(Boolean).slice(0, n);
        return { text: String(r.text || "").slice(0, 4000), figures: strs(r.figures, 8, 300), blank: Boolean(r.blank), fromClaude: true };
      } catch (e) {
        return { ...super.readPage(), error: `Couldn't read page ${page} (${e.message}).` };
      }
    }

    /**
     * Captions (+ optional frames) → summary with timestamped key moments, or
     * orientation when notes on the video are the graded work (spec §12.1).
     */
    async videoSummary(assignment, { video = {}, captions = [], frames = [], question = "" } = {}) {
      try {
        const r = await bridgeCall("videoSummary", {
          assignment: { ...slim(assignment), description: String(assignment.description || "").slice(0, 1500) },
          video: { title: String(video.title || "").slice(0, 150), duration: Number(video.duration) || 0, auto: Boolean(video.auto), lang: String(video.lang || "").slice(0, 8) },
          captions: captions.slice(0, 600).map((c) => ({ t: Math.max(0, Math.round(Number(c.t) || 0)), text: String(c.text || "").slice(0, 400) })),
          question: String(question || "").slice(0, 400),
          imageDataUrls: frames.slice(0, 8),
        }, 180000);
        const strs = (v, n, cap) => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim().slice(0, cap)).filter(Boolean).slice(0, n);
        const moments = (v, n) => (Array.isArray(v) ? v : []).filter((m) => m && typeof m === "object").map((m) => ({ t: Math.max(0, Math.round(Number(m.t) || 0)), point: String(m.point || "").trim().slice(0, 220) })).filter((m) => m.point).slice(0, n);
        const terms = (Array.isArray(r.terms) ? r.terms : []).filter((t) => t && t.term).map((t) => ({ term: String(t.term).slice(0, 60), meaning: String(t.meaning || "").slice(0, 200) })).slice(0, 6);
        return {
          what: String(r.what || "").slice(0, 200),
          summary: String(r.summary || "").slice(0, 1500),
          why: String(r.why || "").slice(0, 200),
          keyPoints: moments(r.keyPoints, 10),
          moments: moments(r.moments, 8),
          listenFor: strs(r.listenFor, 4, 200),
          terms,
          questions: strs(r.questions, 8, 220),
          blind: strs(r.blind, 4, 200),
          answer: String(r.answer || "").slice(0, 1500),
          fromClaude: true,
        };
      } catch (e) {
        return { ...super.videoSummary(), error: `Couldn't summarize the video (${e.message}).` };
      }
    }

    async debrief(record, weekStats = {}) {
      try {
        const r = await bridgeCall("debrief", {
          session: {
            title: record.title,
            course: record.course,
            plannedMin: record.plannedMin,
            actualMin: record.actualMin,
            distractions: record.distractions || 0,
          },
          weekStats,
        }, 45000);
        if (r.line) return { line: String(r.line).slice(0, 200) };
        throw new Error("empty line");
      } catch {
        return super.debrief(record);
      }
    }

    async autopsy(sessions, commitments) {
      if (sessions.length < 3) return super.autopsy(sessions, commitments);
      try {
        // Send aggregates, not raw logs — smaller and it's all the brain needs.
        const data = {
          sessions: sessions.slice(-30).map((s) => ({
            course: s.course,
            startHour: new Date(s.startedAt).getHours(),
            day: new Date(s.endedAt).toLocaleDateString(undefined, { weekday: "short" }),
            plannedMin: s.plannedMin,
            actualMin: s.actualMin,
            distractions: s.distractions || 0,
            mood: s.mood || undefined, // feeling check-in, when answered
          })),
          commitments: {
            kept: commitments.filter((c) => c.keptAt).length,
            missed: commitments.filter((c) => c.missedAt).length,
          },
        };
        const r = await bridgeCall("autopsy", { data });
        if (Array.isArray(r.insights) && r.insights.length) {
          return r.insights.slice(0, 5).map((s) => String(s).slice(0, 220));
        }
        throw new Error("no insights");
      } catch {
        return super.autopsy(sessions, commitments);
      }
    }
  }

  /**
   * Normalize any step list (strings or partial objects) into the checklist
   * shape the work view renders. estMin defaults to an even split of the
   * assignment's estimate, clamped to a 3-25 minute chunk.
   */
  FA.normalizeSteps = function normalizeSteps(list, assignment, source = "rules") {
    const items = (Array.isArray(list) ? list : []).filter(Boolean);
    const share = Math.round((assignment?.estMin || 30) / Math.max(items.length, 1));
    return items.map((s, i) => {
      const o = typeof s === "string" ? { text: s } : s;
      return {
        id: "st" + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 5),
        text: String(o.text || "").slice(0, 160),
        deliverable: String(o.deliverable || "").slice(0, 120),
        estMin: Math.max(3, Math.min(25, Number(o.estMin) || share)),
        done: Boolean(o.done),
        doneBy: o.doneBy || null,
        source,
      };
    });
  };

  /**
   * Practice-test questions: whatever the brain (or the rules) returned →
   * the exact shape the panel grades. Drops anything unusable rather than
   * rendering a broken question. Same schema as ~/Projects/study-kit:
   *   mcq {question, choices[], answer:index}   tf {statement, answer:bool}
   *   short {question, answer, accept[]}        flashcard {term, definition}
   */
  FA.normalizeQuestions = function normalizeQuestions(list) {
    const LETTERS = "ABCDEFGH";
    const str = (v, n) => String(v ?? "").trim().slice(0, n);
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      if (!raw || typeof raw !== "object") continue;
      let type = String(raw.type || "").toLowerCase();
      if (/multiple|choice/.test(type)) type = "mcq";
      else if (/true|bool/.test(type)) type = "tf";
      else if (/card|vocab|term/.test(type)) type = "flashcard";
      else if (/short|text|fill|open/.test(type)) type = "short";
      const q = { id: "pq" + Date.now().toString(36) + out.length + Math.random().toString(36).slice(2, 5), type, explanation: str(raw.explanation, 240) };
      if (type === "mcq") {
        q.question = str(raw.question || raw.q, 400);
        q.choices = (Array.isArray(raw.choices) ? raw.choices : []).map((c) => str(c, 200)).filter(Boolean).slice(0, 6);
        let a = raw.answer;
        if (typeof a === "string") {
          const t = a.trim();
          if (t.length === 1 && LETTERS.includes(t.toUpperCase())) a = LETTERS.indexOf(t.toUpperCase());
          else if (/^\d+$/.test(t)) a = Number(t);
          else a = q.choices.findIndex((c) => c.toLowerCase() === t.toLowerCase());
        }
        q.answer = Number(a);
        if (!q.question || q.choices.length < 2 || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) continue;
      } else if (type === "tf") {
        q.statement = str(raw.statement || raw.question || raw.q, 400);
        const a = raw.answer;
        q.answer = typeof a === "boolean" ? a : /^(true|t|yes|y|1)$/i.test(String(a).trim());
        if (!q.statement) continue;
      } else if (type === "short") {
        q.question = str(raw.question || raw.q, 400);
        q.answer = str(raw.answer || raw.a, 300);
        q.accept = (Array.isArray(raw.accept) ? raw.accept : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 6);
        if (!q.question || !q.answer) continue;
      } else if (type === "flashcard") {
        q.term = str(raw.term || raw.question || raw.q, 300);
        q.definition = str(raw.definition || raw.answer || raw.a, 400);
        if (!q.term || !q.definition) continue;
      } else continue;
      out.push(q);
    }
    return out;
  };

  /** Loose short-answer match: case, punctuation, macrons and a leading article don't count. */
  FA.checkShortAnswer = function checkShortAnswer(q, typed) {
    const norm = (s) => {
      s = String(s || "").toLowerCase().trim().replace(/[āēīōūȳ]/g, (c) => "aeiouy"["āēīōūȳ".indexOf(c)]);
      s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
      for (const a of ["the ", "a ", "an ", "to "]) if (s.startsWith(a)) { s = s.slice(a.length); break; }
      return s;
    };
    const t = norm(typed);
    if (!t) return false;
    const wanted = q.type === "flashcard" ? [q.definition] : [q.answer, ...(q.accept || [])];
    return wanted.map(norm).includes(t);
  };

  /**
   * Turn what a setup plan SAYS into what it OPENS. Brains (and rules) often
   * name the module or a reading in `gather`/`focus`/`firstMove` without
   * adding it to `opens`; the student then sees "open the module" and
   * nothing happens. Match names against the resource inventory and add
   * them. In autopilot, open everything relevant (capped).
   *
   * allLinks (default true): every link the ASSIGNMENT ITSELF carries — the
   * teacher's attached files/links and the ones in the instructions — is
   * opened no matter what the plan says. Smart Start's promise is "opens what
   * you need"; the assignment's own links are always that.
   */
  FA.resolveOpens = function resolveOpens(plan, resources = {}, { aggressive = false, maxOpens = 8, allLinks = true } = {}) {
    const links = resources.links || [];
    const topics = resources.topics || [];
    const opens = [...(plan.opens || [])];
    const has = (kind, i) => opens.some((o) => o.kind === kind && o.i === i);
    const said = [plan.focus, plan.firstMove, ...(plan.gather || [])].filter(Boolean).join(" \n ").toLowerCase();
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

    // 1. Anything the plan names by (roughly) its title.
    topics.forEach((tp, i) => {
      const n = norm(tp.name);
      if (n.length >= 4 && said.includes(n) && !has("topic", i)) opens.push({ kind: "topic", i, why: "named in the plan" });
    });
    links.forEach((l, i) => {
      const n = norm(l.text);
      if (n.length >= 4 && said.includes(n) && !has("link", i)) opens.push({ kind: "link", i, why: "named in the plan" });
    });

    // 2. "the module / class page / topic / resources" with no specific name →
    //    the topic named in the instructions, else the most recently published.
    if (/\b(module|class page|topic|resources|unit page|course page)\b/.test(said) && topics.length && !opens.some((o) => o.kind === "topic")) {
      const desc = norm(resources.description);
      let ti = topics.findIndex((tp) => norm(tp.name).length >= 4 && desc.includes(norm(tp.name)));
      if (ti < 0) {
        const sorted = topics.map((tp, i) => ({ i, at: Date.parse(tp.published || 0) || 0 })).sort((x, y) => y.at - x.at);
        ti = sorted[0]?.i ?? 0;
      }
      opens.push({ kind: "topic", i: ti, why: "the class module" });
    }

    // 3. Autopilot: every teacher link, plus the best topic if none yet.
    if (aggressive) {
      links.forEach((l, i) => { if (!has("link", i)) opens.push({ kind: "link", i, why: "in the instructions" }); });
      if (topics.length && !opens.some((o) => o.kind === "topic")) {
        const sorted = topics.map((tp, i) => ({ i, at: Date.parse(tp.published || 0) || 0 })).sort((x, y) => y.at - x.at);
        opens.push({ kind: "topic", i: sorted[0].i, why: "latest module" });
      }
    }
    // 4. The assignment's own links, always. Attached files/links first (the
    //    teacher put them there on purpose), then links in the instructions.
    if (allLinks) {
      const order = links.map((l, i) => ({ l, i })).sort((a, b) => Number(Boolean(b.l.attached)) - Number(Boolean(a.l.attached)));
      for (const { l, i } of order) {
        if (opens.length >= maxOpens) break;
        if (!has("link", i)) opens.push({ kind: "link", i, why: l.attached ? "attached to the assignment" : "in the instructions" });
      }
    }
    return { ...plan, opens: opens.slice(0, maxOpens) };
  };

  /**
   * Pick the brain at startup: quick health check on the bridge; Claude if
   * it answers, rules if not. Callers can show FA.coachBrain in the UI.
   */
  /** Which server + code a health answer belongs to. Role authorization is only valid for this exact pair. */
  FA.bridgeSig = (url, token) => `${String(url || "").trim().replace(/\/+$/, "") || DEFAULT_BRIDGE}|${String(token || "").trim()}`;
  let probeSeq = 0;

  FA.initCoach = async function initCoach() {
    const seq = ++probeSeq;
    // Whatever we knew is stale the moment we re-probe: no developer
    // authorization survives a server change, a token change, or a failed
    // refresh. Only a fresh, matching, in-order health answer restores it.
    FA.bridgeHealth = null;
    try {
      await loadBridgeConfig();
      const sig = FA.bridgeSig(bridgeCfg.url, bridgeCfg.token);
      const ctrl = new AbortController();
      // A hosted bridge may be asleep (Fly stops idle machines) — give it time to wake.
      const timer = setTimeout(() => ctrl.abort(), bridgeCfg.local ? 1500 : 6000);
      const res = await fetch(`${bridgeCfg.url}/health`, { signal: ctrl.signal, headers: bridgeHeaders() });
      clearTimeout(timer);
      const h = await res.json();
      if (seq !== probeSeq) return FA.coachBrain; // an older probe finishing late: ignore it entirely
      // Hosted + auth on + our code unknown → the coach would 401 on every call. Rules instead.
      if (h && h.ok && h.auth && !h.who) {
        console.warn("[Focus Agent] bridge reachable but the access code is missing/wrong (⚙ → coach server)");
        FA.bridgeHealth = { badToken: true, role: "none", sig };
      } else if (h && h.ok) {
        FA.coach = new ClaudeCoach();
        FA.coachBrain = "claude";
        // role is whatever the server says, or "none" from a server too old to say (never assumed dev)
        FA.bridgeHealth = { ...h, role: h.role === "dev" || h.role === "student" ? h.role : "none", sig };
        if (h.stale) console.warn("[Focus Agent] bridge is running OLD code — restart python3 bridge/coach_server.py");
        return FA.coachBrain;
      }
    } catch {
      /* bridge not running — rules it is */
    }
    if (seq !== probeSeq) return FA.coachBrain;
    if (!FA.bridgeHealth?.badToken) FA.bridgeHealth = null; // keep the wrong-code fact for the badge; it carries role none
    FA.coach = new MockCoach();
    FA.coachBrain = "rules";
    return FA.coachBrain;
  };

  FA.MockCoach = MockCoach;
  FA.ClaudeCoach = ClaudeCoach;
  FA.coach = new MockCoach(); // default until initCoach() upgrades it
  FA.coachBrain = "rules";
})();
