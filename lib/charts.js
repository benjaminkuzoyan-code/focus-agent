/**
 * lib/charts.js - Tiny dependency-free SVG charts.
 *
 * Extensions can't load CDN chart libraries (CSP), and bundling Chart.js
 * for three chart types is overkill. These helpers return SVG strings;
 * callers drop them into innerHTML. All charts inherit the panel's dark
 * theme via currentColor + explicit accent fills.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  // Soft-glass tokens (kept in sync with sidepanel/panel.css).
  // Single-series charts only — each chart uses one hue; the palette was
  // checked with the dataviz validator (CVD, normal-vision, chroma, and
  // 3:1 surface contrast all pass on the dark surface).
  const ACCENT = "#818cf8";
  const ACCENT2 = "#c084fc";
  const MUTED = "#9aa0b4";
  const RED = "#fb7185";

  let gradSeq = 0;
  /** Per-chart <defs> gradient so bars get the soft vertical fade. */
  function gradDef(color) {
    const id = `fagrad${++gradSeq}`;
    return {
      id,
      def: `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.95"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.45"/>
      </linearGradient></defs>`,
    };
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /**
   * Vertical bar chart.
   * @param {Array<{label: string, value: number}>} data
   * @param {Object} [opts] - {width, height, color, unit}
   */
  FA.barChart = function barChart(data, opts = {}) {
    const W = opts.width ?? 280;
    const H = opts.height ?? 110;
    const color = opts.color ?? ACCENT;
    const padB = 16; // room for labels
    const max = Math.max(...data.map((d) => d.value), 1);
    const bw = W / data.length;

    const grad = gradDef(color);
    let bars = "";
    data.forEach((d, i) => {
      const h = Math.max(((H - padB - 4) * d.value) / max, d.value > 0 ? 3 : 1.5);
      const x = i * bw + bw * 0.18;
      const y = H - padB - h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${d.value === 0 ? "rgba(255,255,255,0.06)" : `url(#${grad.id})`}"><title>${esc(d.label)}: ${d.value}${esc(opts.unit ?? "")}</title></rect>`;
      // Label every bar if few, else every other
      if (data.length <= 8 || i % 2 === 0) {
        bars += `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 4}" font-size="8" fill="${MUTED}" text-anchor="middle">${esc(d.label)}</text>`;
      }
    });
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${grad.def}${bars}</svg>`;
  };

  /**
   * Line chart with optional area fill.
   * @param {Array<{label: string, value: number}>} data
   */
  FA.lineChart = function lineChart(data, opts = {}) {
    const W = opts.width ?? 280;
    const H = opts.height ?? 90;
    const color = opts.color ?? ACCENT;
    const padB = 14;
    const max = Math.max(...data.map((d) => d.value), 1);
    const step = data.length > 1 ? W / (data.length - 1) : W;

    const pts = data.map((d, i) => {
      const x = i * step;
      const y = 4 + (H - padB - 8) * (1 - d.value / max);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    let labels = "";
    data.forEach((d, i) => {
      if (data.length <= 6 || i % Math.ceil(data.length / 6) === 0) {
        labels += `<text x="${(i * step).toFixed(1)}" y="${H - 2}" font-size="8" fill="${MUTED}" text-anchor="middle">${esc(d.label)}</text>`;
      }
    });

    const grad = gradDef(color);
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      ${grad.def}
      <polygon points="0,${H - padB} ${pts.join(" ")} ${W},${H - padB}" fill="url(#${grad.id})" opacity="0.28"/>
      <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${pts.map((p, i) => `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="3" fill="${color}" stroke="#0b0c14" stroke-width="1.5"><title>${esc(data[i].label)}: ${data[i].value}</title></circle>`).join("")}
      ${labels}
    </svg>`;
  };

  /**
   * Horizontal bar list (for "top offenders" style rankings).
   * @param {Array<{label: string, value: number}>} data - pre-sorted desc
   */
  FA.hbarChart = function hbarChart(data, opts = {}) {
    const W = opts.width ?? 280;
    const rowH = 22;
    const H = data.length * rowH;
    const color = opts.color ?? RED;
    const max = Math.max(...data.map((d) => d.value), 1);
    const labelW = 92;

    let rows = "";
    data.forEach((d, i) => {
      const w = ((W - labelW - 34) * d.value) / max;
      const y = i * rowH;
      rows += `
        <text x="0" y="${y + 14}" font-size="10" fill="${MUTED}">${esc(d.label.slice(0, 14))}</text>
        <rect x="${labelW}" y="${y + 5}" width="${Math.max(w, 3).toFixed(1)}" height="11" rx="5.5" fill="${color}" opacity="0.8"/>
        <text x="${labelW + Math.max(w, 3) + 6}" y="${y + 14}" font-size="10" fill="${MUTED}">${d.value}${esc(opts.unit ?? "")}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${rows}</svg>`;
  };

  /* ---------------- data shapers (sessions → chart data) ---------------- */

  /** Focused minutes per day for the last n days. */
  FA.minutesPerDay = function minutesPerDay(sessions, n = 14) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const day = new Date();
      day.setDate(day.getDate() - i);
      const key = day.toDateString();
      const min = sessions.filter((s) => new Date(s.endedAt).toDateString() === key)
        .reduce((a, s) => a + s.actualMin, 0);
      out.push({ label: `${day.getMonth() + 1}/${day.getDate()}`, value: min });
    }
    return out;
  };

  /** Sessions started per hour-of-day (finds your real power hours). */
  FA.sessionsByHour = function sessionsByHour(sessions) {
    const buckets = [
      { label: "6-9a", lo: 6, hi: 9 }, { label: "9-12", lo: 9, hi: 12 },
      { label: "12-3", lo: 12, hi: 15 }, { label: "3-6p", lo: 15, hi: 18 },
      { label: "6-9p", lo: 18, hi: 21 }, { label: "9-12a", lo: 21, hi: 24 },
    ];
    return buckets.map((b) => ({
      label: b.label,
      value: sessions.filter((s) => {
        const h = new Date(s.startedAt).getHours();
        return h >= b.lo && h < b.hi;
      }).reduce((a, s) => a + s.actualMin, 0),
    }));
  };

  /** Distraction events aggregated by site, with estimated refocus cost. */
  FA.distractionsBySite = function distractionsBySite(sessions) {
    const bySite = {};
    for (const s of sessions) {
      for (const ev of s.distractionEvents || []) {
        const site = (ev.host || "unknown").replace(/^www\./, "");
        bySite[site] = (bySite[site] || 0) + 1;
      }
    }
    // ~23 min refocus cost per interruption — Gloria Mark, UC Irvine.
    return Object.entries(bySite)
      .map(([label, count]) => ({ label, value: count, costMin: count * 23 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  };

  /** Distractions per session, chronological (is it getting better?). */
  FA.distractionTrend = function distractionTrend(sessions, n = 10) {
    return sessions.slice(-n).map((s, i) => ({
      label: `${new Date(s.endedAt).getMonth() + 1}/${new Date(s.endedAt).getDate()}`,
      value: s.distractions || 0,
    }));
  };
})();
