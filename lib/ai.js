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
      if (h < 0) reason = `Overdue. About ${fmtMin(top.estMin)} of work.`;
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
      return FA.normalizeSteps(this.breakdown(assignment), assignment, "rules");
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
        firstMove: this.breakdown(assignment)[0],
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

      // Teacher links: open them all (capped) — they're in the instructions
      // for a reason.
      links.slice(0, 3).forEach((l, i) => opens.push({ kind: "link", i, why: l.text || "linked in instructions" }));

      // Topic/module: one that's named in the instructions, else the only one.
      if (opens.length < 3 && topics.length) {
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
        firstMove: this.breakdown(assignment)[0],
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
          "Start the bridge for a real read-through — rules can't grade a draft.",
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
      return { summary: bullets.map((b) => "• " + b).join("\n") + "\n(rules only — first sentences. Start the bridge for a real summary.)", fromClaude: false };
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
      return { reply: "The real brain is offline — start the bridge (python3 bridge/coach_server.py) and ask again.", fromClaude: false };
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
      return { cards: uniq, fromClaude: false, error: uniq.length ? "" : "No highlights or definition-style sentences to build cards from yet — highlight the key lines in the reading first, or start the bridge." };
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

    /* ---- Ben's build (rules can't do the work; say so) ---- */
    writeStep() {
      return { text: "", fromClaude: false, error: "The real brain is offline — start the bridge to have the coach write this." };
    }
    answerAll() {
      return { text: "", fromClaude: false, error: "The real brain is offline — start the bridge to have the coach answer these." };
    }
    readPhoto() {
      return { legible: false, stepsDone: [], feedback: "The real brain is offline — start the bridge and try the photo again.", fromClaude: false };
    }
    editDoc() {
      return { ops: [], summary: "", fromClaude: false, error: "The real brain is offline — start the bridge to edit the doc." };
    }

    chat(_messages, _context) {
      return {
        reply:
          "The real brain is offline — I'm just the rules right now. Start the bridge " +
          "(python3 bridge/coach_server.py in the project folder) and I'll actually talk.",
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
  const BRIDGE = "http://127.0.0.1:8000";

  async function bridgeCall(method, payload, timeoutMs = 60000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BRIDGE}/coach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        const r = await bridgeCall(
          "chat",
          {
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
        if (r.reply) return { reply: String(r.reply).slice(0, 6000) };
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
          .slice(0, 3)
          .map((o) => ({ kind: o.kind, i: Number(o.i), why: String(o.why || "").slice(0, 60) }));
        return {
          opens,
          doc: Boolean(r.doc) && Boolean(resources.googleConnected),
          gather: (Array.isArray(r.gather) ? r.gather : []).slice(0, 4).map((g) => String(g).slice(0, 80)),
          focus: String(r.focus || "").slice(0, 140) || super.setup(assignment, resources).focus,
          firstMove: String(r.firstMove || "").slice(0, 140) || this.breakdown(assignment)[0],
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

    /* ---- Ben's build ---- */
    async writeStep(assignment, step, steps = [], docText = "") {
      try {
        const r = await bridgeCall("writeStep", {
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
        const r = await bridgeCall("answerAll", {
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
        const r = await bridgeCall("editDoc", {
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
   * Pick the brain at startup: quick health check on the bridge; Claude if
   * it answers, rules if not. Callers can show FA.coachBrain in the UI.
   */
  FA.initCoach = async function initCoach() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${BRIDGE}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      const h = await res.json();
      if (h.ok) {
        FA.coach = new ClaudeCoach();
        FA.coachBrain = "claude";
        FA.bridgeHealth = h; // {started, sourceMtime, stale, methods}
        if (h.stale) console.warn("[Focus Agent] bridge is running OLD code — restart python3 bridge/coach_server.py");
        return FA.coachBrain;
      }
    } catch {
      /* bridge not running — rules it is */
    }
    FA.coach = new MockCoach();
    FA.coachBrain = "rules";
    return FA.coachBrain;
  };

  FA.MockCoach = MockCoach;
  FA.ClaudeCoach = ClaudeCoach;
  FA.coach = new MockCoach(); // default until initCoach() upgrades it
  FA.coachBrain = "rules";
})();
