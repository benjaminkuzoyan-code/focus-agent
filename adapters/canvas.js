/**
 * adapters/canvas.js - Canvas LMS adapter.
 *
 * Canvas exposes a real JSON API to the logged-in browser session:
 *   /api/v1/courses?enrollment_state=active            courses (→ class names)
 *   /api/v1/planner/items?start_date=…                 assignments + quizzes, with submission state
 *   /api/v1/courses/:c/assignments/:a                  full description for one assignment
 *   /api/v1/users/self/todo                            fallback when planner is off
 * Responses are prefixed with "while(1);" to block naive cross-site reads;
 * we strip it. Works on *.instructure.com AND on schools' own domains
 * (canvas.someschool.org) once the student connects that portal (⚙ →
 * connect my school), which registers the content script there.
 *
 * Tested against the public API docs only until a real account runs it —
 * ⚙ → copy debug info is how a tester hands us what went wrong.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  async function canvasFetch(path) {
    const res = await fetch(path, { credentials: "include", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Canvas API ${res.status} for ${path.split("?")[0]}`);
    const text = await res.text();
    return JSON.parse(text.replace(/^while\(1\);/, ""));
  }

  const strip = (html) =>
    String(html || "")
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  /** Teacher links inside the description (for Smart Start's resource inventory). */
  const linksIn = (html) => {
    const out = [];
    const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(String(html || ""))) && out.length < 8) {
      const url = m[1];
      if (/^https?:/.test(url)) out.push({ url, text: strip(m[2]).slice(0, 80) || url });
    }
    return out;
  };

  let courseCache = null;
  async function courses() {
    if (courseCache) return courseCache;
    try {
      const list = await canvasFetch("/api/v1/courses?enrollment_state=active&include[]=teachers&per_page=50");
      courseCache = list.map((c) => ({
        sectionId: String(c.id),
        course: c.name || c.course_code || `course ${c.id}`,
        teacher: (c.teachers || []).map((t) => t.display_name).join(", "),
        block: "",
        academic: true,
        grade: null,
      }));
    } catch (e) {
      console.warn("[Focus Agent] Canvas course lookup failed:", e.message);
      courseCache = [];
    }
    return courseCache;
  }

  FA.adapters = FA.adapters || {};
  FA.adapters.canvas = {
    name: "canvas",

    matches(host) {
      return /instructure\.com$/.test(host) || FA.portalOverride === "canvas";
    },

    async fetchClasses() {
      return courses();
    },

    async fetchAssignments({ includeFinished = false } = {}) {
      const names = Object.fromEntries((await courses()).map((c) => [c.sectionId, c.course]));
      const start = new Date(Date.now() - 2 * 86400000).toISOString(); // catch just-overdue work too
      let items;
      try {
        items = await canvasFetch(`/api/v1/planner/items?start_date=${encodeURIComponent(start)}&per_page=50`);
      } catch (e) {
        console.warn("[Focus Agent] Planner API failed, trying todo:", e.message);
        const todo = await canvasFetch("/api/v1/users/self/todo?per_page=50");
        return todo
          .filter((t) => t.assignment)
          .map((t) =>
            FA.makeAssignment({
              id: t.assignment.id,
              title: t.assignment.name,
              course: names[String(t.course_id)] || t.context_name,
              type: (t.assignment.submission_types || []).join(" ") + " " + t.assignment.name,
              dueDate: t.assignment.due_at,
              points: t.assignment.points_possible,
              url: t.assignment.html_url ? new URL(t.assignment.html_url, location.origin).href : location.href,
              source: "canvas",
              raw: t,
            })
          )
          .map((a) => ({ ...a, sectionId: String(a.raw.course_id || ""), description: strip(a.raw.assignment?.description), links: linksIn(a.raw.assignment?.description) }));
      }

      const wanted = items.filter((i) => ["assignment", "quiz", "discussion_topic"].includes(i.plannable_type));
      const out = [];
      for (const i of wanted) {
        const submitted = Boolean(i.submissions && (i.submissions.submitted || i.submissions.graded));
        if (submitted && !includeFinished) continue;
        // Descriptions aren't in the planner feed; fetch a handful (they're
        // what Smart Start and the breakdown read). Cap to keep it quick.
        let description = "";
        let html = "";
        if (out.length < 15 && i.course_id && i.plannable_id && i.plannable_type === "assignment") {
          try {
            const full = await canvasFetch(`/api/v1/courses/${i.course_id}/assignments/${i.plannable_id}`);
            html = full.description || "";
            description = strip(html);
          } catch {
            /* fine without */
          }
        }
        const a = FA.makeAssignment({
          id: `${i.plannable_type}-${i.plannable_id}`,
          title: i.plannable?.title,
          course: names[String(i.course_id)] || i.context_name,
          type: i.plannable_type === "quiz" ? "test" : `${i.plannable?.title || ""} ${description.slice(0, 80)}`,
          dueDate: i.plannable?.due_at || i.plannable_date,
          points: i.plannable?.points_possible,
          url: i.html_url ? new URL(i.html_url, location.origin).href : location.href,
          source: "canvas",
          raw: i,
        });
        a.sectionId = String(i.course_id || "");
        a.description = description;
        a.links = linksIn(html);
        a.finished = submitted;
        out.push(a);
      }
      return out;
    },
  };
})();
