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

    return Math.round(timePressure * weight + points * weight + effort / 10);
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
