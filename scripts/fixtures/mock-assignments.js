/**
 * scripts/fixtures/mock-assignments.js - TEST FIXTURE ONLY (not shipped).
 * Fake portal data for the jsdom smoke tests; the extension itself never
 * shows demo data any more — no portal means an empty list with instructions.
 *
 * The default data source until school starts. Shaped by makeAssignment()
 * like every real adapter, so the rest of the app cannot tell the
 * difference. Dates are relative to "now" so the demo always feels live.
 *
 * The dataset is deliberately dramatic: an overdue item, a
 * three-things-due-tomorrow crunch (Panic Button demo), and a Unit Test
 * in 6 days with related assignments (Boss Battle demo).
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  function inDays(days, hour = 23, minute = 59) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  }

  const DATA = [
    // Overdue — urgency handling
    { title: "Unit 1 test corrections", course: "World History", type: "homework", due: inDays(-1), points: 10 },
    // Teacher-flagged MISSING with attached links — must be pinned first, and
    // Smart Start must open both links (v0.8.17 regression guard).
    {
      title: "Worksheet: Dunbar-Ortiz ch. 2", course: "World History", type: "homework", due: inDays(-5), points: 5, missing: true,
      links: [
        { url: "https://docs.google.com/document/d/mock-worksheet/edit", text: "Worksheet", attached: true },
        { url: "https://en.wikipedia.org/wiki/Culture_of_Conquest", text: "Reading", attached: true },
      ],
    },

    // The crunch: three due tomorrow (Panic Button demo)
    { title: "Read chapters 3-4 and annotate", course: "English 9", type: "reading", due: inDays(1), points: 10 },
    { title: "Problem set 2.1-2.4 (odd problems)", course: "Algebra II", type: "homework", due: inDays(1), points: 20 },
    { title: "Personal narrative essay: first draft", course: "English 9", type: "essay", due: inDays(1), points: 50 },

    // Mid-range
    { title: "Lab report: density of unknown liquids", course: "Biology", type: "lab", due: inDays(3), points: 30 },
    { title: "Spanish oral presentation outline", course: "Spanish II", type: "project", due: inDays(5), points: 25 },

    // The boss: Biology unit test with lead-up work (Boss Battle demo)
    { title: "Study guide: cell structure vocab", course: "Biology", type: "homework", due: inDays(4), points: 10 },
    { title: "Practice quiz: organelles", course: "Biology", type: "homework", due: inDays(5), points: 10 },
    { title: "UNIT TEST: Cell Structure & Function", course: "Biology", type: "test", due: inDays(6), points: 100 },

    // Long-range (Focus Forecast shows the storm building)
    { title: "History research project: pick topic + 3 sources", course: "World History", type: "project", due: inDays(8), points: 40 },
    { title: "Read chapters 5-6", course: "English 9", type: "reading", due: inDays(9), points: 10 },
  ];

  FA.adapters = FA.adapters || {};
  FA.adapters.mock = {
    matches() {
      return false; // never auto-selected from a page; chosen explicitly
    },
    async fetchAssignments() {
      return DATA.map((d) => {
        const a = FA.makeAssignment({
          title: d.title,
          course: d.course,
          type: d.type,
          dueDate: d.due,
          points: d.points,
          // Real-but-neutral URLs so Smart Start's tab-opening is testable.
          url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(d.course.replace(/ /g, "_")),
          source: "mock",
          raw: d,
        });
        // The extra fields real adapters add (see adapters/blackbaud.js).
        if (d.missing) a.missing = true;
        if (d.links) a.links = d.links;
        return a;
      });
    },
  };
})();
