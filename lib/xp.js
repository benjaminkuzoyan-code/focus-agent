/**
 * lib/xp.js - Boss Battles: XP, levels, and quests wired to REAL schoolwork.
 *
 * Habitica is make-believe on manual entry; this runs on the school's actual
 * data feed. Focus minutes earn XP. Subjects level independently. A test on
 * the portal becomes a BOSS whose HP drains as you complete its lead-up
 * assignments and log study sessions for that course.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  // 1 focused minute = 1 XP; completing a quest = its estimated minutes as bonus XP.
  FA.xpFromSessions = function xpFromSessions(sessions) {
    return sessions.reduce((sum, s) => sum + s.actualMin, 0);
  };

  FA.totalXp = function totalXp(sessions, questEvents) {
    return FA.xpFromSessions(sessions) + questEvents.reduce((sum, q) => sum + q.xp, 0);
  };

  /** Level curve: level n needs n^2 * 50 XP. Gentle early, grindy later. */
  FA.levelFor = function levelFor(xp) {
    const level = Math.floor(Math.sqrt(xp / 50)) + 1;
    const currentFloor = (level - 1) ** 2 * 50;
    const nextAt = level ** 2 * 50;
    return { level, progress: xp - currentFloor, needed: nextAt - currentFloor };
  };

  /** Per-course XP (sessions + quest bonuses attributed to that course). */
  FA.courseXp = function courseXp(sessions, questEvents) {
    const xp = {};
    for (const s of sessions) xp[s.course] = (xp[s.course] || 0) + s.actualMin;
    for (const q of questEvents) xp[q.course] = (xp[q.course] || 0) + q.xp;
    return xp;
  };

  /**
   * Find bosses: every not-done test-type assignment. HP = the lead-up work.
   *   maxHp   = count of same-course assignments due before the test + 2
   *             (the +2 represents study sessions for the course itself)
   *   damage  = completed lead-ups + study sessions logged for that course
   *             since the boss appeared (capped at 2)
   */
  FA.findBosses = function findBosses(assignments, meta, sessions) {
    const bosses = [];
    for (const test of assignments) {
      if (test.type !== "test" || meta?.[test.id]?.done) continue;
      const testDue = new Date(test.dueDate || Date.now());

      const leadUps = assignments.filter(
        (a) =>
          a.id !== test.id &&
          a.course === test.course &&
          a.dueDate &&
          new Date(a.dueDate) <= testDue
      );
      const doneLeadUps = leadUps.filter((a) => meta?.[a.id]?.done);

      const studySessions = sessions.filter(
        (s) => s.course === test.course && s.endedAt > Date.now() - 7 * 86400000
      );

      const maxHp = leadUps.length + 2;
      const damage = doneLeadUps.length + Math.min(studySessions.length, 2);

      bosses.push({
        test,
        maxHp,
        hp: Math.max(0, maxHp - damage),
        leadUps,
        doneLeadUps: doneLeadUps.length,
        studySessions: Math.min(studySessions.length, 2),
      });
    }
    return bosses;
  };
})();
