/**
 * lib/snapshot.js - The Student Snapshot: everything the coach knows, in one object.
 *
 * The pivot: the extension no longer just reads the assignment list — it reads
 * the whole portal (classes, grades, schedule, topics, assignment text) and
 * builds ONE normalized snapshot that every feature consumes:
 *
 *   {
 *     builtAt:     ISO timestamp
 *     source:      "blackbaud" | "canvas" | ...
 *     student:     { name, school, schoolYear }          — no ids, no email
 *     classes:     [{ sectionId, course, block, teacher, grade, ... }]
 *     assignments: [Assignment + description/sectionId/status/late/missing]
 *     grades:      { [sectionId]: [GradedAssignment] }
 *     schedule:    [{ title, start, end, sectionId, room }]   next 7 days
 *     topics:      { [sectionId]: [Topic] }
 *     icalLink:    string                                  — personal feed URL
 *   }
 *
 * Built inside the portal tab (content script) because that's where the
 * cookies are. Cached in chrome.storage.local so the side panel, popup and
 * background worker can use it after the tab closes. NEVER sent anywhere
 * as-is: FA.snapshotForBrain() strips it down before it goes to Claude.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  const SNAPSHOT_KEY = "studentSnapshot";

  /** Run a list of async jobs, tolerating individual failures. */
  async function settle(jobs) {
    const results = await Promise.allSettled(jobs.map((fn) => fn()));
    return results.map((r) => (r.status === "fulfilled" ? r.value : null));
  }

  /**
   * Build a fresh snapshot from whichever adapter claims this page.
   * Adapters that only implement fetchAssignments() still work — the other
   * sections just come back empty.
   */
  FA.buildSnapshot = async function buildSnapshot(adapter) {
    const has = (m) => typeof adapter[m] === "function";
    const errors = [];
    const note = (what) => (e) => {
      errors.push(`${what}: ${e.message}`);
      return null;
    };

    const [profile, classes, assignments, schedule, icalLink] = await settle([
      () => (has("fetchProfile") ? adapter.fetchProfile().catch(note("profile")) : null),
      () => (has("fetchClasses") ? adapter.fetchClasses().catch(note("classes")) : []),
      () => adapter.fetchAssignments({ includeFinished: true }).catch(note("assignments")),
      () => (has("fetchSchedule") ? adapter.fetchSchedule(new Date(), 7).catch(note("schedule")) : []),
      () => (has("fetchICalLink") ? adapter.fetchICalLink().catch(note("ical")) : ""),
    ]);

    const all = assignments || [];

    // A class is academic if the adapter says so OR it has assignments —
    // study hall and assembly never do; a history class with no grades yet does.
    const withWork = new Set(all.map((a) => a.sectionId).filter(Boolean));
    for (const c of classes || []) {
      if (withWork.has(c.sectionId)) c.academic = true;
    }

    // Grades + topics are per-class; fan out over academic sections only.
    const academic = (classes || []).filter((c) => c.academic);
    const grades = {};
    const topics = {};
    if (has("fetchGrades") || has("fetchTopics")) {
      await Promise.all(
        academic.map(async (c) => {
          if (has("fetchGrades")) grades[c.sectionId] = (await adapter.fetchGrades(c).catch(note(`grades ${c.course}`))) || [];
          if (has("fetchTopics")) topics[c.sectionId] = (await adapter.fetchTopics(c).catch(note(`topics ${c.course}`))) || [];
        })
      );
    }
    return {
      builtAt: new Date().toISOString(),
      source: all[0]?.source || adapter.name || "unknown",
      student: profile
        ? { name: profile.name, school: profile.school, schoolYear: profile.schoolYear }
        : null,
      classes: classes || [],
      assignments: all.filter((a) => !a.finished),
      finished: all.filter((a) => a.finished),
      grades,
      schedule: schedule || [],
      topics,
      icalLink: icalLink || "",
      errors,
    };
  };

  FA.saveSnapshot = async function saveSnapshot(snapshot) {
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshot });
  };

  FA.loadSnapshot = async function loadSnapshot() {
    const obj = await chrome.storage.local.get(SNAPSHOT_KEY);
    return obj[SNAPSHOT_KEY] || null;
  };

  /* ------------------------------------------------------------------ *
   * Derived views — small helpers so features don't re-derive the same
   * things from the raw snapshot.
   * ------------------------------------------------------------------ */

  /** Class lookup by the course string assignments carry. */
  FA.classForAssignment = function classForAssignment(snapshot, assignment) {
    if (assignment.sectionId) {
      const bySection = snapshot.classes.find((c) => c.sectionId === assignment.sectionId);
      if (bySection) return bySection;
    }
    return snapshot.classes.find((c) => c.course === assignment.course) || null;
  };

  /** Grade trend for a class: last N graded items with percentages. */
  FA.gradeTrend = function gradeTrend(snapshot, sectionId, n = 5) {
    const rows = (snapshot.grades[sectionId] || [])
      .filter((g) => g.percentage != null)
      .sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));
    return rows.slice(-n).map((g) => ({ title: g.title, pct: g.percentage, letter: g.letter }));
  };

  /** Where the student is at risk: low grade, missing/late work, overdue. */
  FA.riskReport = function riskReport(snapshot) {
    const risks = [];
    for (const c of snapshot.classes.filter((x) => x.academic)) {
      const gs = snapshot.grades[c.sectionId] || [];
      const missing = gs.filter((g) => g.flags.missing).length;
      const late = gs.filter((g) => g.flags.late).length;
      if (c.grade != null && c.grade < 80) risks.push({ course: c.course, kind: "grade", detail: `${c.grade}% right now` });
      if (missing) risks.push({ course: c.course, kind: "missing", detail: `${missing} missing` });
      if (late) risks.push({ course: c.course, kind: "late", detail: `${late} late` });
    }
    for (const a of snapshot.assignments) {
      if (a.missing || FA.hoursUntil(a.dueDate) < 0) {
        risks.push({ course: a.course, kind: "overdue", detail: a.title });
      }
    }
    return risks;
  };

  /**
   * What goes to the AI. Principle: the brain gets what a good tutor would
   * be told, nothing that identifies the student or their school.
   *   - no names, ids, emails, teacher emails, raw portal objects
   *   - descriptions truncated; grades as numbers only
   */
  FA.snapshotForBrain = function snapshotForBrain(snapshot, { maxAssignments = 20 } = {}) {
    const cls = snapshot.classes
      .filter((c) => c.academic)
      .map((c) => ({
        course: c.course,
        grade: c.grade,
        recent: FA.gradeTrend(snapshot, c.sectionId, 4),
        topics: (snapshot.topics[c.sectionId] || []).slice(0, 6).map((t) => t.name),
      }));
    const asg = snapshot.assignments.slice(0, maxAssignments).map((a) => ({
      id: a.id,
      title: a.title,
      course: a.course,
      type: a.type,
      due: a.dueDate,
      points: a.points || undefined,
      late: a.late || undefined,
      missing: a.missing || undefined,
      description: a.description ? a.description.slice(0, 2000) : undefined,
    }));
    const sched = snapshot.schedule.slice(0, 40).map((s) => ({ title: s.title, start: s.start, end: s.end }));
    return { classes: cls, assignments: asg, schedule: sched, risks: FA.riskReport(snapshot) };
  };
})();
