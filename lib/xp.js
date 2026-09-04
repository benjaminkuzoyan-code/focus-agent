/**
 * lib/xp.js - XP and levels from REAL focus minutes.
 *
 * 1 focused minute = 1 XP; finishing an assignment adds its estimate as a
 * bonus. Lives behind ▸more in the student build. (Boss battles were cut
 * 2026-09-03 — no interview evidence, cost UI.)
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
})();
