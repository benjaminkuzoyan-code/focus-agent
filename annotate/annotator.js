/**
 * annotate/annotator.js - Draw on any webpage.
 *
 * Injected ON DEMAND (chrome.scripting.executeScript from the side panel's
 * "✏️ Annotate" button) — it is NOT a persistent content script, so it's
 * fully self-contained: no FA libs, chrome.storage.local accessed directly.
 *
 * Injecting again on the same page toggles the annotator off.
 *
 * Strokes are stored per normalized URL (origin + path, query/hash dropped)
 * in page coordinates, so highlights on a reading are still there when the
 * page is reopened. Known v1 limit: anchored to positions, not text — a
 * page that reflows (window resized) can shift underneath them.
 */
(() => {
  // ---- Toggle: second injection tears down the first. ----
  const existing = document.getElementById("fa-anno-toolbar");
  if (existing) {
    document.getElementById("fa-anno-canvas")?.remove();
    existing.remove();
    window.faAnnoCleanup?.();
    return;
  }

  const pageKey = "fa-anno:" + location.origin + location.pathname;

  // Highlighter is translucent + fat; pen is solid + thin.
  const COLORS = ["#ffd83b", "#6c7cff", "#4ade80", "#f87171"];
  let tool = "highlighter"; // "pen" | "highlighter" | "eraser"
  let color = COLORS[0];
  let strokes = []; // [{tool, color, points: [{x,y}...]}]
  let current = null;
  let drawing = false;

  // ---- Canvas over the whole document ----
  const canvas = document.createElement("canvas");
  canvas.id = "fa-anno-canvas";
  const sizeCanvas = () => {
    canvas.width = Math.max(document.documentElement.scrollWidth, innerWidth);
    canvas.height = Math.max(document.documentElement.scrollHeight, innerHeight);
    redraw();
  };
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  function strokeStyle(s) {
    if (s.tool === "highlighter") {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 14;
    } else {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.5;
    }
    ctx.strokeStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  function drawStroke(s) {
    if (s.points.length < 2) return;
    strokeStyle(s);
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) drawStroke(s);
  }

  // ---- Persistence ----
  async function load() {
    const obj = await chrome.storage.local.get(pageKey);
    strokes = obj[pageKey] || [];
    redraw();
  }
  async function save() {
    await chrome.storage.local.set({ [pageKey]: strokes });
  }

  // ---- Pointer handling (page coordinates = client + scroll) ----
  const pt = (e) => ({ x: e.clientX + scrollX, y: e.clientY + scrollY });

  function eraseNear(p) {
    const before = strokes.length;
    strokes = strokes.filter((s) => !s.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 16));
    if (strokes.length !== before) {
      redraw();
      save();
    }
  }

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    drawing = true;
    const p = pt(e);
    if (tool === "eraser") {
      eraseNear(p);
      return;
    }
    current = { tool, color, points: [p] };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pt(e);
    if (tool === "eraser") {
      eraseNear(p);
      return;
    }
    current.points.push(p);
    redraw();
    drawStroke(current);
  });
  const finish = () => {
    if (drawing && current && current.points.length > 1) {
      strokes.push(current);
      save();
    }
    drawing = false;
    current = null;
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointerleave", finish);

  // ---- Toolbar ----
  const bar = document.createElement("div");
  bar.id = "fa-anno-toolbar";
  bar.innerHTML = `
    <button class="fa-anno-btn" data-tool="highlighter" title="Highlighter">🖍️</button>
    <button class="fa-anno-btn" data-tool="pen" title="Pen">✏️</button>
    <button class="fa-anno-btn" data-tool="eraser" title="Eraser (click strokes)">🧽</button>
    <span class="fa-anno-sep"></span>
    ${COLORS.map((c) => `<button class="fa-anno-color" data-color="${c}" style="background:${c}"></button>`).join("")}
    <span class="fa-anno-sep"></span>
    <button class="fa-anno-btn" data-action="clear" title="Clear this page">🗑️</button>
    <button class="fa-anno-btn" data-action="close" title="Close annotator">✖️</button>`;
  document.body.appendChild(bar);

  function refreshBar() {
    bar.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    bar.querySelectorAll("[data-color]").forEach((b) => b.classList.toggle("active", b.dataset.color === color));
  }
  bar.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.tool) tool = t.dataset.tool;
    if (t.dataset.color) color = t.dataset.color;
    if (t.dataset.action === "clear") {
      strokes = [];
      redraw();
      await save();
    }
    if (t.dataset.action === "close") {
      canvas.remove();
      bar.remove();
      window.faAnnoCleanup?.();
      return;
    }
    refreshBar();
  });

  // ---- Wire-up ----
  window.addEventListener("resize", sizeCanvas);
  window.faAnnoCleanup = () => {
    window.removeEventListener("resize", sizeCanvas);
    delete window.faAnnoCleanup;
  };

  sizeCanvas();
  refreshBar();
  load();
})();
