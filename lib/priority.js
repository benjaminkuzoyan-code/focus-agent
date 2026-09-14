/**
 * lib/priority.js - Urgency scoring + effort estimates.
 *
 * The effort estimate starts as a heuristic by assignment type, then gets
 * PERSONAL: once the student has logged real sessions, estimates come from
 * their own measured pace ("essays take YOU ~90 min"). That learned pace is
 * the beginning of the data moat — no competitor can copy it without the
 * student's history.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  // Baseline minutes by type — deliberately rough; personal pace replaces them.
  const BASE_EFFORT = { test: 60, project: 90, essay: 90, lab: 60, homework: 30, reading: 40, other: 30 };

  // How much a type tends to matter (grade impact per minute of neglect).
  const TYPE_WEIGHT = { test: 3.0, project: 2.2, essay: 2.0, lab: 1.6, homework: 1.2, reading: 1.0, other: 1.0 };

  FA.hoursUntil = function hoursUntil(iso) {
    if (!iso) return 24 * 14; // no due date = treat as two weeks out
    return (new Date(iso) - new Date()) / 3600000;
  };

  /**
   * Estimated minutes for an assignment: the student's measured average for
   * this type if we have >= 2 sessions of history for it, else the baseline.
   */
  FA.estimateMinutes = function estimateMinutes(assignment, sessions) {
    const relevant = (sessions || []).filter((s) => {
      // Match sessions to type via title keywords of the session's assignment.
      return FA.normalizeType(s.title) === assignment.type;
    });
    if (relevant.length >= 2) {
      const avg = relevant.reduce((sum, s) => sum + s.actualMin, 0) / relevant.length;
      return Math.round(avg);
    }
    return BASE_EFFORT[assignment.type] ?? 30;
  };

  /**
   * Urgency score. Bigger = work on it sooner. Blends:
   *  - time pressure (overdue explodes, then closeness of deadline)
   *  - grade impact (points + type weight)
   *  - size (big tasks need earlier starts than their deadline suggests)
   */
  FA.urgencyScore = function urgencyScore(assignment, sessions) {
    const h = FA.hoursUntil(assignment.dueDate);
    const effort = FA.estimateMinutes(assignment, sessions);
    const weight = TYPE_WEIGHT[assignment.type] ?? 1.0;
    const points = assignment.points || 10;

    let timePressure;
    if (h < 0) timePressure = 1000 + Math.min(-h, 240); // overdue: always on top
    else timePressure = 500 / Math.max(h - effort / 60, 0.5); // hours left AFTER the work itself
    // Teacher-flagged MISSING sits above everything, even plain overdue: it's
    // already a zero in the gradebook and the fastest grade fix there is.
    if (assignment.missing) timePressure += 2000;

    return Math.round(timePressure * weight + points * weight + effort / 10);
  };

  /**
   * "Behind" = the student owes this right now: the teacher marked it missing,
   * the portal says overdue, or the due date has passed. The list pins these
   * in their own section at the top; the pick never looks past them.
   */
  FA.isBehind = function isBehind(a) {
    if (!a) return false;
    return Boolean(a.missing || a.overdue) || (a.dueDate ? FA.hoursUntil(a.dueDate) < 0 : false);
  };

  /**
   * Avoidance detection — the signature is behavioral, from data we already
   * hold: the assignment has been VISIBLE for days, it's getting URGENT, and
   * the student has logged ZERO sessions on it. Research frames
   * procrastination as emotion regulation (the task feels too big), so the
   * caller's job is to respond with a tiny first step, not a guilt trip.
   *
   * Flags when (not done) AND (no sessions for this assignment) AND either:
   *   - overdue (never touched + past due IS avoidance, day one), or
   *   - visible ≥ 3 days AND due within 5 days.
   */
  FA.findAvoided = function findAvoided(ranked, meta, sessions) {
    const now = Date.now();
    const touched = new Set((sessions || []).map((s) => s.assignmentId));
    return ranked
      .filter((a) => {
        if (touched.has(a.id)) return false;
        const h = FA.hoursUntil(a.dueDate);
        if (h < 0) return true; // overdue + never touched
        const seen = meta?.[a.id]?.firstSeenAt;
        const daysVisible = seen ? (now - seen) / 86400000 : 0;
        return daysVisible >= 3 && h < 120;
      })
      .map((a) => ({
        assignment: a,
        daysVisible: Math.max(
          1,
          Math.round((now - (meta?.[a.id]?.firstSeenAt || now)) / 86400000)
        ),
        overdue: FA.hoursUntil(a.dueDate) < 0,
      }));
  };

  /**
   * Ramp: how long should THIS sitting be? Proposed from the student's own
   * recent sessions, never from the assignment's size. S04 asked for short
   * chunks with a visible checkpoint; S06 works in natural 20-min cycles;
   * Ben's own log had 14 of 20 sessions die inside minute one. So:
   *   - if half of recent sessions ended inside 3 min → 5 (start tiny)
   *   - else the median of recent real sittings, snapped to 5s, 5..25
   *   - no history → half the estimate, 10..25
   * Returns {minutes, why} — the why is shown next to the chips.
   */
  FA.proposeChunk = function proposeChunk(sessions, assignment) {
    const recent = (sessions || []).slice(-12);
    const shortStops = recent.filter((s) => (s.actualMin || 0) < 3).length;
    if (recent.length >= 4 && shortStops / recent.length >= 0.5) {
      return { minutes: 5, why: `${shortStops} of your last ${recent.length} sittings ended inside 3 min — start with 5` };
    }
    const real = recent.filter((s) => (s.actualMin || 0) >= 3 && s.endedBy !== "abandon").map((s) => s.actualMin).sort((a, b) => a - b);
    if (real.length >= 3) {
      const med = real[Math.floor(real.length / 2)];
      const minutes = Math.max(5, Math.min(25, Math.round(med / 5) * 5 || 5));
      return { minutes, why: `your last ${real.length} sittings ran ~${med} min` };
    }
    const est = assignment?.estMin || 25;
    const minutes = Math.max(10, Math.min(25, Math.round(est / 2 / 5) * 5 || 10));
    return { minutes, why: "no history yet — half the estimate" };
  };

  /** Sort assignments most-urgent-first, skipping ones marked done. */
  FA.rankAssignments = function rankAssignments(assignments, meta, sessions) {
    return assignments
      .filter((a) => !meta?.[a.id]?.done)
      .map((a) => ({
        ...a,
        estMin: FA.estimateMinutes(a, sessions),
        urgency: FA.urgencyScore(a, sessions),
      }))
      .sort((a, b) => b.urgency - a.urgency);
  };
})();
