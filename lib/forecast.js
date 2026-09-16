/**
 * lib/forecast.js - The Focus Forecast: weather for your week.
 *
 * Planners show lists; nobody shows WEATHER. Each of the next 7 days gets a
 * workload total (estimated minutes of everything due that day, tests
 * counted heavier because they need study time in advance) and a sky
 * condition. The forecast also produces one actionable headline, e.g.
 * "Thursday is a storm — start the essay Tuesday."
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  const LEVELS = [
    { max: 1, icon: "☀️", label: "clear" },
    { max: 45, icon: "🌤️", label: "light" },
    { max: 90, icon: "⛅", label: "busy" },
    { max: 150, icon: "🌧️", label: "heavy" },
    { max: Infinity, icon: "⛈️", label: "STORM" },
  ];

  FA.buildForecast = function buildForecast(assignments, meta, sessions) {
    const days = [];
    const now = new Date();

    for (let i = 0; i < 7; i++) {
      const day = new Date(now);
      day.setDate(day.getDate() + i);
      const dayStr = day.toDateString();

      const due = assignments.filter(
        (a) => !meta?.[a.id]?.done && !a.finished && a.dueDate && new Date(a.dueDate).toDateString() === dayStr
      );

      let load = 0;
      for (const a of due) {
        const est = FA.estimateMinutes(a, sessions);
        // A test due day X means studying, mostly before day X — count 1.5x.
        load += a.type === "test" ? est * 1.5 : est;
      }

      const level = LEVELS.find((l) => load <= l.max);
      days.push({
        date: day,
        name: i === 0 ? "Today" : i === 1 ? "Tmrw" : day.toLocaleDateString(undefined, { weekday: "short" }),
        due,
        loadMin: Math.round(load),
        icon: level.icon,
        label: level.label,
      });
    }

    return { days, headline: buildHeadline(days) };
  };

  function buildHeadline(days) {
    const storm = days.find((d) => d.label === "STORM" || d.label === "heavy");
    if (!storm) {
      const total = days.reduce((s, d) => s + d.loadMin, 0);
      return total === 0
        ? "Clear skies all week. Bank some time on long-range work."
        : "Manageable week. Steady daily sessions keep it that way.";
    }
    // Recommend starting on the lightest day before the storm.
    const before = days.filter((d) => d.date < storm.date && d.loadMin < 60);
    const startDay = before.length ? before[before.length - 1].name : "today";
    const dayName = storm.date.toLocaleDateString(undefined, { weekday: "long" });
    return `⛈️ ${dayName} is a storm (~${Math.round(storm.loadMin / 60 * 10) / 10}h due). Start ${startDay} or it's an all-nighter.`;
  }
})();
