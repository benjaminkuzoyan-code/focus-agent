/**
 * adapters/classroom.js - Google Classroom adapter (classroom.google.com).
 *
 * Classroom has NO page-level JSON API we can piggyback on (the official
 * Classroom API needs OAuth — a later upgrade). v1 scrapes the DOM of the
 * to-do page instead. DOM scraping is inherently brittle: Google's class
 * names are obfuscated and change, so we anchor on structure and ARIA
 * attributes, and try several strategies before giving up.
 *
 * UNTESTED until Ben runs this on a friend's Classroom account — expect to
 * tweak selectors there. Everything funnels through makeAssignment(), so
 * fixes stay inside this file.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  /** Try to parse dates like "Due Tomorrow", "Due Aug 15", "Due Friday". */
  function parseClassroomDue(text) {
    if (!text) return "";
    const t = text.replace(/^due\s*/i, "").trim();
    const now = new Date();

    if (/today/i.test(t)) return now.toISOString();
    if (/tomorrow/i.test(t)) {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
    // Weekday names → next occurrence of that weekday.
    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const wd = weekdays.findIndex((w) => new RegExp(w, "i").test(t));
    if (wd >= 0) {
      const d = new Date(now);
      d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7 || 7));
      return d.toISOString();
    }
    // "Aug 15" style — assume this year (or next, if that date already passed).
    const parsed = new Date(`${t} ${now.getFullYear()}`);
    if (!isNaN(parsed.getTime())) {
      if (parsed < now) parsed.setFullYear(parsed.getFullYear() + 1);
      return parsed.toISOString();
    }
    return "";
  }

  FA.adapters = FA.adapters || {};
  FA.adapters.classroom = {
    name: "classroom",
    matches(host) {
      return host === "classroom.google.com" || FA.portalOverride === "classroom";
    },

    async fetchAssignments() {
      const results = [];

      // Strategy 1: the to-do page lists assignments as links to
      // classroom.google.com/c/<course>/a/<assignment>/details.
      const links = Array.from(document.querySelectorAll('a[href*="/details"]'));
      for (const link of links) {
        const title = link.textContent?.trim();
        if (!title) continue;

        // Walk up to the list item and look for course + due text nearby.
        const item = link.closest("li, [role='listitem'], div");
        const itemText = item ? item.innerText : "";
        const dueMatch = itemText.match(/due[^\n]*/i);
        // Course name is usually the line after the title inside the card.
        const lines = itemText.split("\n").map((s) => s.trim()).filter(Boolean);
        const titleIdx = lines.findIndex((l) => l === title);
        const course = titleIdx >= 0 && lines[titleIdx + 1] && !/due/i.test(lines[titleIdx + 1])
          ? lines[titleIdx + 1]
          : "";

        // classroom.google.com/c/<course>/a/<assignment>/details -- the assignment id is
        // the only stable key. Without it makeAssignment hashes title|course|dueDate, and
        // "Due Today" resolves to a fresh timestamp every fetch, so every id churned.
        const href = link.getAttribute("href") || "";
        const idMatch = href.match(/\/a\/([\w-]+)/);
        results.push(
          FA.makeAssignment({
            id: idMatch ? idMatch[1] : undefined,
            title,
            course,
            type: title,
            dueDate: parseClassroomDue(dueMatch ? dueMatch[0] : ""),
            points: 0, // not visible on the to-do list
            url: new URL(link.getAttribute("href"), location.origin).href,
            source: "classroom",
            raw: { itemText },
          })
        );
      }

      if (results.length === 0) {
        throw new Error(
          "No assignments found in the page. Open classroom.google.com's To-do view " +
            "(menu → To-do), or the selectors need updating for this account."
        );
      }

      // De-dupe by id (the same assignment can appear in multiple sections).
      const seen = new Set();
      return results.filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));
    },
  };
})();
