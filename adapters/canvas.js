/**
 * adapters/canvas.js - Canvas LMS adapter (*.instructure.com).
 *
 * Canvas exposes a real JSON API to the logged-in browser session — same
 * trick as Blackbaud, but Canvas's API is public and documented:
 *   /api/v1/planner/items   (assignments + events, the Planner feed)
 *   /api/v1/users/self/todo (fallback: ungraded submissions to do)
 *
 * Canvas wraps JSON responses with a "while(1);" prefix to block naive
 * cross-site reads; we strip it before parsing.
 *
 * UNTESTED until Ben runs this on a friend's Canvas account — see the
 * README test checklist.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  async function canvasFetch(path) {
    const res = await fetch(path, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Canvas API returned ${res.status} for ${path}`);
    const text = await res.text();
    return JSON.parse(text.replace(/^while\(1\);/, ""));
  }

  FA.adapters = FA.adapters || {};
  FA.adapters.canvas = {
    matches(host) {
      return /instructure\.com$/.test(host);
    },

    async fetchAssignments() {
      // Course id → name map so assignments show "Biology", not "course_123".
      const courseNames = {};
      try {
        const courses = await canvasFetch("/api/v1/courses?enrollment_state=active&per_page=50");
        for (const c of courses) courseNames[c.id] = c.name || c.course_code || "";
      } catch (e) {
        // Non-fatal: we just lose pretty course names.
        console.warn("[Focus Agent] Canvas course lookup failed:", e.message);
      }

      const start = new Date().toISOString();
      let items = [];
      try {
        items = await canvasFetch(`/api/v1/planner/items?start_date=${start}&per_page=50`);
      } catch (e) {
        // Older Canvas instances may lack the planner API; fall back to todo.
        console.warn("[Focus Agent] Planner API failed, trying todo:", e.message);
        const todo = await canvasFetch("/api/v1/users/self/todo?per_page=50");
        return todo
          .filter((t) => t.assignment)
          .map((t) =>
            FA.makeAssignment({
              title: t.assignment.name,
              course: courseNames[t.course_id] || t.context_name,
              type: (t.assignment.submission_types || []).join(" "),
              dueDate: t.assignment.due_at,
              points: t.assignment.points_possible,
              url: t.assignment.html_url ? new URL(t.assignment.html_url, location.origin).href : location.href,
              source: "canvas",
              raw: t,
            })
          );
      }

      return items
        .filter((i) => i.plannable_type === "assignment" || i.plannable_type === "quiz")
        .filter((i) => !(i.submissions && i.submissions.submitted))
        .map((i) =>
          FA.makeAssignment({
            title: i.plannable?.title,
            course: courseNames[i.course_id] || i.context_name,
            type: i.plannable_type === "quiz" ? "test" : i.plannable?.title,
            dueDate: i.plannable?.due_at || i.plannable_date,
            points: i.plannable?.points_possible,
            url: i.html_url ? new URL(i.html_url, location.origin).href : location.href,
            source: "canvas",
            raw: i,
          })
        );
    },
  };
})();
