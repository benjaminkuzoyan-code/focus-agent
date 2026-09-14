/**
 * adapters/blackbaud.js - Blackbaud / myschoolapp.com adapter.
 *
 * Calls the same internal DataDirect APIs the portal's own pages use. Every
 * request runs FROM the portal page (content script), so the browser attaches
 * the student's login cookies. Nothing here ever sees or stores a password,
 * and no cookie ever leaves the browser — that's a hard rule of the product.
 *
 * Endpoints (all verified live on polytechnic.myschoolapp.com, 2026-08-29):
 *   /api/webapp/context                                  who am I (UserInfo.UserId, persona)
 *   /api/datadirect/SchoolYearsGet?userId=               school years; Current=true is this year
 *   /api/DataDirect/AssignmentCenterAssignments/         assignments (snake_case fields)
 *   /api/assignment2/read/<assignment_id>/?personaId=2   one assignment's attached LinkItems + DownloadItems
 *   /api/datadirect/ParentStudentUserAcademicGroupsGet   classes/sections + cumgrade + markingperiodid
 *   /api/datadirect/GradeBookPerformanceAssignmentStudentList/   graded assignments for one section
 *   /api/datadirect/ScheduleList?viewerId&start&end      class meetings (unix seconds)
 *   /api/datadirect/sectiontopicsget/<sectionId>/        teacher-published topics (syllabus-ish)
 *   /api/iCalRSS/iCalScheduleGet?userId=                 personal iCal feed URL
 *
 * assignment_status codes seen live (re-verified 2026-09-14 against 76 items):
 *   -1 = to do, 0 = in progress, 1 = completed (student-marked), 2 = OVERDUE
 *   (past due, not turned in), 4 = graded. missing_ind = the teacher marked
 *   it missing (can sit on status 1, 2 or 4). Treating 2 as "completed" is
 *   the bug that hid every overdue/missing assignment until v0.8.17.
 *
 * PascalCase fallbacks are kept on the assignment mapping in case another
 * Blackbaud tenant differs. `raw` is kept on every item for debugging.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  const PERSONA_STUDENT = 2;

  /** GET a portal JSON endpoint with cookies; throws on HTTP or shape errors. */
  async function getJson(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Blackbaud ${res.status} for ${url.split("?")[0]}`);
    const data = await res.json();
    if (data && data.Error) throw new Error(`Blackbaud error: ${data.Error}`);
    return data;
  }

  /**
   * True when the assignment is genuinely done: completed (1) or graded (4)
   * AND the teacher hasn't flagged it missing. Status 2 is OVERDUE, never
   * finished. A "completed" item the teacher marked missing still needs work.
   */
  function isFinished(item) {
    const status = Number(item.assignment_status ?? item.AssignmentStatus ?? -1);
    const missing = Boolean(item.missing_ind ?? item.MissingInd);
    return (status === 1 || status === 4) && !missing;
  }
  const STATUS_OVERDUE = 2;

  function formatDate(date) {
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
  }

  /** Strip HTML from teacher-written descriptions; keep line breaks readable. */
  function stripHtml(html) {
    return String(html || "")
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Pull the teacher's hyperlinks OUT of the raw HTML before stripHtml
   * destroys them — links in the instructions (docs, readings, videos) are
   * the most setup-relevant data an assignment has. Smart Setup opens them.
   */
  function extractLinks(html) {
    const out = [];
    const seen = new Set();
    const push = (url, text) => {
      try {
        const abs = new URL(url, location.origin).href;
        if (!/^https?:/.test(abs) || seen.has(abs)) return;
        seen.add(abs);
        out.push({ url: abs, text: (text || "").trim().slice(0, 80) || abs.replace(/^https?:\/\//, "").slice(0, 60) });
      } catch { /* unparseable href — skip */ }
    };
    const raw = String(html || "");
    // <a href="...">text</a>
    for (const m of raw.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      push(m[1], m[2].replace(/<[^>]+>/g, ""));
    }
    // bare URLs typed into the text
    for (const m of raw.replace(/<[^>]+>/g, " ").matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
      push(m[0], "");
    }
    return out.slice(0, 8);
  }

  /**
   * The teacher's ATTACHED links and files live outside the description:
   * Blackbaud's assignment detail endpoint returns them as LinkItems and
   * DownloadItems. Fetched once per assignment per page load (in-memory
   * cache), only for unfinished items, a few at a time.
   */
  const detailCache = new Map(); // assignment_id -> Promise<links[]>
  function fetchAttachedLinks(assignmentId) {
    if (!assignmentId) return Promise.resolve([]);
    if (!detailCache.has(assignmentId)) {
      const p = getJson(`/api/assignment2/read/${assignmentId}/?format=json&personaId=${PERSONA_STUDENT}`)
        .then((d) => {
          const out = [];
          for (const l of d?.LinkItems || []) {
            if (l?.Url) out.push({ url: l.Url, text: String(l.ShortDescription || l.UrlDisplay || "").trim().slice(0, 80), attached: true });
          }
          for (const f of d?.DownloadItems || []) {
            const u = f?.DownloadUrl || f?.Url;
            if (u) out.push({ url: new URL(u, location.origin).href, text: String(f.FriendlyFileName || f.ShortDescription || f.FileName || "").trim().slice(0, 80), attached: true, download: true });
          }
          return out;
        })
        .catch((e) => {
          detailCache.delete(assignmentId); // let a later refresh retry
          console.warn("[Focus Agent] attached links failed for", assignmentId, e.message);
          return [];
        });
      detailCache.set(assignmentId, p);
    }
    return detailCache.get(assignmentId);
  }

  /** Run async jobs a few at a time (the portal is happier with 4 than 40). */
  async function inBatches(items, limit, fn) {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    });
    await Promise.all(workers);
  }

  // Cached per page load: who the student is + which school year is current.
  let profilePromise = null;

  /**
   * ONE-TAP "MARK COMPLETE" — SPIKE PENDING (2026-09-03).
   * Blackbaud has no documented student-side endpoint for the checkbox that
   * flips assignment_status to 1. To wire this up: in myPoly, open DevTools →
   * Network, tick an assignment complete by hand, and copy the request (URL,
   * method, body, headers) into this function. Until then it throws, and the
   * product falls back to detecting the flip via the status poll.
   */
  async function markComplete(assignmentIndexId) {
    throw new Error(`markComplete(${assignmentIndexId}) not wired yet — capture the portal's own request first (see adapters/blackbaud.js)`);
  }

  FA.adapters = FA.adapters || {};
  FA.adapters.blackbaud = {
    markComplete,
    /** True when the current page is a Blackbaud portal. */
    name: "blackbaud",
    matches(host) {
      if (FA.portalOverride === "blackbaud") return true;
      return /myschoolapp\.com$|blackbaud\.com$/.test(host);
    },

    /* ---------------------------------------------------------------- *
     * Profile: user id + current school year (needed by most calls)
     * ---------------------------------------------------------------- */
    async fetchProfile() {
      if (!profilePromise) {
        profilePromise = (async () => {
          const ctx = await getJson("/api/webapp/context");
          const user = ctx.UserInfo || {};
          const userId = user.UserId ?? user.userId;
          if (!userId) throw new Error("Blackbaud context has no UserId");
          const years = await getJson(`/api/datadirect/SchoolYearsGet?userId=${userId}`);
          const current = (years || []).find((y) => y.Current) || years[years.length - 1];
          return {
            userId,
            name: [user.FirstName, user.LastName].filter(Boolean).join(" ") || user.UserName || "",
            schoolYear: current?.Label || "",
            school: location.hostname.split(".")[0],
          };
        })().catch((e) => {
          profilePromise = null; // let the next call retry
          throw e;
        });
      }
      return profilePromise;
    },

    /* ---------------------------------------------------------------- *
     * Assignments (the original feature)
     * ---------------------------------------------------------------- */
    async fetchAssignments({ includeFinished = false, monthsAhead = 4, daysBack = 60 } = {}) {
      // Start two months back so OVERDUE and MISSING work is in the list. A
      // missing assignment from three weeks ago is exactly the one the
      // student needs to see; 14 days used to hide it.
      const today = new Date();
      today.setDate(today.getDate() - daysBack);
      const end = new Date();
      end.setMonth(end.getMonth() + monthsAhead);

      const params = new URLSearchParams({
        format: "json",
        filter: "2",
        dateStart: formatDate(today),
        dateEnd: formatDate(end),
        persona: String(PERSONA_STUDENT),
        statusList: "",
        sectionList: "",
      });

      const items = await getJson(`/api/DataDirect/AssignmentCenterAssignments/?${params}`);
      if (!Array.isArray(items)) {
        throw new Error("Blackbaud API returned unexpected shape (not an array)");
      }

      const assignments = items
        .filter((item) => includeFinished || !isFinished(item))
        .map((item) => {
          const indexId = item.assignment_index_id ?? item.AssignmentIndexId ?? item.AssignmentId;
          const a = FA.makeAssignment({
            id: indexId,
            title: item.short_description ?? item.ShortDescription ?? item.Description,
            course: item.groupname ?? item.GroupName ?? item.SectionName,
            // Some items have a null type; makeAssignment then infers from the title.
            type: item.assignment_type ?? item.AssignmentType,
            dueDate: item.date_due ?? item.DateDue,
            points: item.maxpoints ?? item.MaxPoints ?? item.Points,
            // Assignment Center deep link; falls back to the page we're on.
            url: indexId
              ? `${location.origin}/lms-assignment/assignment/assignment-student-view/${indexId}`
              : location.href,
            source: "blackbaud",
            raw: item,
          });
          // Extra fields the pivot features need. Kept off the core schema so
          // other adapters don't have to provide them.
          a.description = stripHtml(item.long_description);
          a.links = extractLinks(item.long_description);
          a.sectionId = item.section_id ?? null;
          a.status = Number(item.assignment_status ?? -1);
          a.finished = isFinished(item);
          a.late = Boolean(item.late_ind);
          a.missing = Boolean(item.missing_ind);
          const pastDue = a.dueDate ? new Date(a.dueDate) < new Date() : false;
          a.overdue = a.status === STATUS_OVERDUE || (pastDue && !a.finished);
          a.assignedDate = FA.toISO(item.date_assigned);
          a.hasAttachments = Boolean(item.has_link || item.has_download);
          return a;
        });

      // Attached links + files (the ones Smart Start must open) come from the
      // detail endpoint. Only for work that's still pending, 4 at a time.
      const pending = assignments.filter((a) => !a.finished && a.hasAttachments && a.raw?.assignment_id);
      await inBatches(pending, 4, async (a) => {
        const attached = await fetchAttachedLinks(a.raw.assignment_id);
        if (!attached.length) return;
        const seen = new Set(attached.map((l) => l.url));
        a.links = [...attached, ...(a.links || []).filter((l) => !seen.has(l.url))].slice(0, 12);
      });
      return assignments;
    },

    /* ---------------------------------------------------------------- *
     * Classes: every section the student is in, with current grade
     * ---------------------------------------------------------------- */
    async fetchClasses() {
      const { userId, schoolYear } = await this.fetchProfile();
      const params = new URLSearchParams({
        userId,
        schoolYearLabel: schoolYear,
        memberLevel: "3",
        persona: String(PERSONA_STUDENT),
        durationList: "",
        markingPeriodId: "",
      });
      const groups = await getJson(`/api/datadirect/ParentStudentUserAcademicGroupsGet?${params}`);
      return (groups || []).map((g) => ({
        sectionId: g.sectionid,
        name: g.sectionidentifier,            // "PolyEnriched Chemistry - 3 (F)"
        course: String(g.sectionidentifier || "").replace(/\s*\([^)]*\)\s*$/, ""), // matches assignment.course
        block: (String(g.sectionidentifier || "").match(/\(([^)]*)\)\s*$/) || [])[1] || "",
        teacher: g.groupownername || "",
        teacherEmail: g.groupowneremail || "",
        room: g.room || "",
        level: g.schoollevel || "",
        term: g.currentterm || "",
        markingPeriodId: g.markingperiodid ?? null,
        durationId: g.DurationId ?? null,
        // null when the teacher hasn't published grades / no graded work yet
        grade: g.cumgrade != null && g.cumgrade !== "" ? Number(g.cumgrade) : null,
        gradeDisplay: g.CumulativeDisplay || "",
        overdueCount: g.OverdueCount ?? 0,
        upcomingCount: g.UpcomingCount ?? 0,
        // Provisional: a class with a marking period is graded. buildSnapshot
        // also marks any class that has assignments as academic, because some
        // graded classes (e.g. history) show no marking period until the
        // teacher posts a first grade.
        academic: g.markingperiodid != null,
        raw: g,
      }));
    },

    /* ---------------------------------------------------------------- *
     * Grades: every graded assignment in one section
     * ---------------------------------------------------------------- */
    async fetchGrades(section) {
      const { userId } = await this.fetchProfile();
      if (!section.markingPeriodId) return [];
      const params = new URLSearchParams({
        sectionId: section.sectionId,
        markingPeriodId: section.markingPeriodId,
        studentUserId: userId,
        persona: String(PERSONA_STUDENT),
      });
      const rows = await getJson(`/api/datadirect/GradeBookPerformanceAssignmentStudentList/?${params}`);
      return (rows || []).map((r) => ({
        assignmentId: r.AssignmentId,
        title: r.AssignmentShortDescription || r.Assignment || "",
        type: r.AssignmentType || "",
        points: r.Points === "" || r.Points == null ? null : Number(r.Points),
        maxPoints: r.MaxPoints == null ? null : Number(r.MaxPoints),
        percentage: r.AssignmentPercentage == null || r.AssignmentPercentage === "" ? null : Number(r.AssignmentPercentage),
        letter: r.Letter || "",
        weight: r.Weight == null ? null : Number(r.Weight),
        dueDate: FA.toISO(r.DateDue),
        sectionGrade: r.SectionGrade == null || r.SectionGrade === "" ? null : Number(r.SectionGrade),
        flags: {
          late: Number(r.LateTotal) > 0,
          missing: Number(r.MissingTotal) > 0,
          incomplete: Number(r.IncompleteTotal) > 0,
          exempt: Number(r.ExemptTotal) > 0,
        },
        raw: r,
      }));
    },

    /* ---------------------------------------------------------------- *
     * Schedule: class meetings between two dates
     * ---------------------------------------------------------------- */
    async fetchSchedule(start = new Date(), days = 7) {
      const { userId } = await this.fetchProfile();
      const from = new Date(start);
      from.setHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setDate(to.getDate() + days);
      const params = new URLSearchParams({
        viewerId: userId,
        personaId: "null",
        viewerPersonaId: "null",
        start: String(Math.floor(from.getTime() / 1000)),
        end: String(Math.floor(to.getTime() / 1000)),
      });
      const rows = await getJson(`/api/datadirect/ScheduleList?${params}`);
      return (rows || []).map((r) => ({
        title: r.title || "",
        start: FA.toISO(r.start),
        end: FA.toISO(r.end),
        allDay: Boolean(r.allDay),
        sectionId: r.SectionId ?? null,
        teacher: r.facultyName || "",
        room: [r.buildingName, r.roomName || r.roomNumber].filter(Boolean).join(" "),
        raw: r,
      }));
    },

    /* ---------------------------------------------------------------- *
     * Topics: what the teacher has published for a class (closest thing
     * Blackbaud has to a syllabus; many classes have none)
     * ---------------------------------------------------------------- */
    async fetchTopics(section) {
      const params = new URLSearchParams({
        format: "json",
        active: "true",
        future: "false",
        expired: "false",
        sharedTopics: "false",
      });
      try {
        const rows = await getJson(`/api/datadirect/sectiontopicsget/${section.sectionId}/?${params}`);
        return (rows || []).map((t) => ({
          id: t.TopicIndexID ?? t.TopicID,
          name: t.Name || "",
          description: stripHtml(t.Description),
          published: FA.toISO(t.PublishDate),
          url: `${location.origin}/app/student#topicdetail/${t.TopicID}/${t.TopicIndexID}/0/${section.sectionId}`,
        }));
      } catch {
        return []; // no topics tab for this class — normal, not an error
      }
    },

    /* ---------------------------------------------------------------- *
     * iCal: the student's personal schedule feed. Subscribing to this in
     * Google/Apple Calendar is the zero-backend path to phone notifications.
     * ---------------------------------------------------------------- */
    async fetchICalLink() {
      const { userId } = await this.fetchProfile();
      const r = await getJson(`/api/iCalRSS/iCalScheduleGet?userId=${userId}&personaId=null&viewerPersonaId=null`);
      return r?.iCalLink || "";
    },
  };
})();
