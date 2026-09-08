/**
 * lib/storage.js - All persistent state, in chrome.storage.local.
 *
 * Everything stays ON THIS DEVICE. That's the privacy story for parents
 * and schools ("we never see your grades"), and it's also just simpler.
 *
 * Keys:
 *   sessions         [{id, assignmentId, title, course, startedAt, endedAt,
 *                      plannedMin, actualMin, distractions, checkins}]
 *   activeSession    {assignmentId, title, course, startedAt, plannedMin,
 *                      distractions, lastNudgeAt} | null
 *   commitments      [{id, text, assignmentId, dueAt, keptAt, missedAt, createdAt}]
 *   questEvents      [{assignmentId, course, xp, at}]   (completed quests)
 *   assignmentMeta   {[assignmentId]: {done, doneAt, spentMin}}
 *   assignmentsCache {items: [Assignment], fetchedAt, source}
 *   settings         {dataSource: "auto", sessionMin, checkinMin, mode: "tutor"|"answer", devMode, …}
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  const DEFAULT_SETTINGS = { dataSource: "auto", sessionMin: 25, checkinMin: 10, mode: "tutor", devMode: false };

  async function get(key, fallback) {
    const obj = await chrome.storage.local.get(key);
    return obj[key] ?? fallback;
  }
  async function set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  FA.store = {
    // --- settings ---
    async getSettings() {
      return { ...DEFAULT_SETTINGS, ...(await get("settings", {})) };
    },
    async setSettings(patch) {
      await set("settings", { ...(await this.getSettings()), ...patch });
    },

    // --- assignments cache (so the panel works away from the portal tab) ---
    async cacheAssignments(items, source) {
      await set("assignmentsCache", { items, source, fetchedAt: Date.now() });
    },
    async getCachedAssignments() {
      return get("assignmentsCache", null);
    },

    // --- per-assignment metadata ---
    async getMeta() {
      return get("assignmentMeta", {});
    },
    async markDone(assignmentId, done = true) {
      const meta = await this.getMeta();
      meta[assignmentId] = { ...(meta[assignmentId] || {}), done, doneAt: done ? Date.now() : null };
      await set("assignmentMeta", meta);
    },
    /** Generic per-assignment metadata patch (e.g. docUrl from Doc Starter). */
    async patchAssignmentMeta(assignmentId, patch) {
      const meta = await this.getMeta();
      meta[assignmentId] = { ...(meta[assignmentId] || {}), ...patch };
      await set("assignmentMeta", meta);
    },
    /**
     * Record when each assignment was first seen — the clock that avoidance
     * detection runs on ("visible for N days, zero sessions").
     */
    async trackSeen(assignments) {
      const meta = await this.getMeta();
      let changed = false;
      const now = Date.now();
      for (const a of assignments) {
        if (!meta[a.id]?.firstSeenAt) {
          meta[a.id] = { ...(meta[a.id] || {}), firstSeenAt: now };
          changed = true;
        }
      }
      if (changed) await set("assignmentMeta", meta);
      return meta;
    },
    async addTimeSpent(assignmentId, minutes) {
      const meta = await this.getMeta();
      const m = meta[assignmentId] || {};
      m.spentMin = (m.spentMin || 0) + minutes;
      meta[assignmentId] = m;
      await set("assignmentMeta", meta);
    },

    // --- focus sessions ---
    async getActiveSession() {
      return get("activeSession", null);
    },
    async startSession(assignment, plannedMin, extra = {}) {
      const session = {
        assignmentId: assignment.id,
        title: assignment.title,
        course: assignment.course,
        startedAt: Date.now(),
        plannedMin,           // current chunk length (the student can change it)
        chunkMin: plannedMin, // what Ramp proposed
        mode: "screen",       // "screen" | "paper" (no doc, no tab activity)
        activityCount: 0,     // tab switches/loads during the session (worker counts)
        tabs: [],             // tabs Smart Start opened; [0] is the assignment itself
        distractions: 0,
        checkins: 0,
        lastNudgeAt: 0,
        ...extra,
      };
      await set("activeSession", session);
      return session;
    },
    async updateActiveSession(patch) {
      const s = await this.getActiveSession();
      if (!s) return null;
      const updated = { ...s, ...patch };
      await set("activeSession", updated);
      return updated;
    },
    /** Record one distraction with its site — feeds the distraction analytics. */
    async addDistractionEvent(host) {
      const s = await this.getActiveSession();
      if (!s) return null;
      const events = s.distractionEvents || [];
      events.push({ at: Date.now(), host: host || "unknown" });
      return this.updateActiveSession({
        distractionEvents: events,
        distractions: (s.distractions || 0) + 1,
      });
    },
    /**
     * Close the active session. `endedBy` says what ended it — "user" (done
     * tap), "stop" (left early), "portal"/"submit"/"steps"/"doc" (detected
     * completion, Phase 3). Every session is recorded, including short ones:
     * a 1-minute stop is the most important data point we have.
     */
    async endSession(endedBy = "user", extra = {}) {
      const s = await this.getActiveSession();
      if (!s) return null;
      const actualMin = Math.max(1, Math.round((Date.now() - s.startedAt) / 60000));
      const record = {
        endedBy,
        ...extra,
        id: "s" + s.startedAt,
        assignmentId: s.assignmentId,
        title: s.title,
        course: s.course,
        startedAt: s.startedAt,
        endedAt: Date.now(),
        plannedMin: s.plannedMin,
        chunkMin: s.chunkMin || s.plannedMin,
        mode: s.mode || "screen",
        actualMin,
        distractions: s.distractions,
        distractionEvents: s.distractionEvents || [],
        checkins: s.checkins,
        mood: s.mood || null, // from the feeling check-in, when answered
      };
      const sessions = await get("sessions", []);
      sessions.push(record);
      await set("sessions", sessions);
      await set("activeSession", null);
      await this.addTimeSpent(s.assignmentId, actualMin);
      return record;
    },
    async getSessions() {
      return get("sessions", []);
    },

    // --- commitments ("I'll start at 4") ---
    async getCommitments() {
      return get("commitments", []);
    },
    async addCommitment(text, dueAt, assignmentId = null) {
      const list = await this.getCommitments();
      list.push({
        id: "c" + Date.now(),
        text,
        assignmentId,
        dueAt,
        keptAt: null,
        missedAt: null,
        createdAt: Date.now(),
      });
      await set("commitments", list);
    },
    async resolveCommitment(id, kept) {
      const list = await this.getCommitments();
      const c = list.find((x) => x.id === id);
      if (c) {
        if (kept) c.keptAt = Date.now();
        else c.missedAt = Date.now();
        await set("commitments", list);
      }
    },

    // --- quests / XP events ---
    async getQuestEvents() {
      return get("questEvents", []);
    },
    async addQuestEvent(assignment, xp) {
      const list = await this.getQuestEvents();
      list.push({ assignmentId: assignment.id, course: assignment.course, xp, at: Date.now() });
      await set("questEvents", list);
    },
  };

  // --- derived stats (computed, never stored, so they can't drift) ---

  /** Streak = consecutive calendar days (ending today or yesterday) with >= 1 session. */
  FA.computeStreak = function computeStreak(sessions) {
    if (!sessions.length) return 0;
    const days = new Set(sessions.map((s) => new Date(s.endedAt).toDateString()));
    let streak = 0;
    const cursor = new Date();
    // Allow the streak to survive if today has no session *yet*.
    if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
    while (days.has(cursor.toDateString())) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  };
})();
