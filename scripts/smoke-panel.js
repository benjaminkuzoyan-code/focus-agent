/**
 * scripts/smoke-panel.js - Boot the side panel in jsdom with a fake chrome.*
 * API and click through list → Smart Start → work → done. Not a unit test —
 * a "does it even load" gate. Run: NODE_PATH=<dir with jsdom> node scripts/smoke-panel.js
 * (jsdom is not a project dependency; `npm i jsdom` anywhere and point NODE_PATH at it).
 */const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "sidepanel/panel.html"), "utf8");

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e.detail?.stack || e.message)));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));
vc.on("warn", () => {});
vc.on("log", () => {});

const store = {}; // fake chrome.storage.local
const changeListeners = [];
const emit = (changes) => changeListeners.forEach((fn) => { try { fn(changes, "local"); } catch (e) { errors.push("onChanged: " + e.stack); } });
const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: store[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store[k]]));
        return { ...store };
      },
      async set(obj) {
        const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { oldValue: store[k], newValue: v }]));
        Object.assign(store, obj);
        emit(changes);
      },
      async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); },
    },
    onChanged: { addListener(fn) { changeListeners.push(fn); } },
  },
  permissions: { async request() { return true; }, async getAll() { return { origins: [] }; } },
  tabs: {
    async query() { return []; },
    async create(o) { created.push(o.url); return { id: 1, url: o.url }; },
    async get() { return { id: 1 }; },
    async move() {},
    async sendMessage() { throw new Error("no tab"); },
    onUpdated: { addListener() {} },
    onActivated: { addListener() {} },
  },
  windows: { async create() { return { id: 2 }; }, async getCurrent() { return { id: 1 }; } },
  runtime: { async sendMessage() { return {}; }, getManifest: () => ({ version: "test" }), getURL: (p) => "chrome-extension://test/" + p },
  scripting: { async insertCSS() {}, async executeScript() {} },
  identity: { getAuthToken: (o, cb) => cb && cb(undefined) },
  alarms: { create() {}, clear() {} },
};
const created = [];

const dom = new JSDOM(html, {
  url: "chrome-extension://test/sidepanel/panel.html",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.chrome = chrome;
    window.fetch = async () => { throw new Error("offline"); };
    window.confirm = () => false;
    window.navigator.clipboard = { writeText: async () => {} };
    window.scrollTo = () => {};
  },
});
const { window } = dom;

// Load scripts in the order panel.html declares them.
const srcs = [...dom.window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"));
for (const src of srcs) {
  const file = path.join(ROOT, "sidepanel", src);
  try {
    window.eval(fs.readFileSync(file, "utf8"));
  } catch (e) {
    errors.push(`while loading ${src}: ${e.stack}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => window.document.getElementById(id);
const visible = (id) => $(`view-${id}`).classList.contains("active");

(async () => {
  await sleep(2500); // boot: initCoach health check times out at 1.5s, then loads mock data

  const results = [];
  const check = (name, ok, extra = "") => results.push(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);

  const cards = window.document.querySelectorAll("#today-list .card");
  check("list renders mock assignments", cards.length > 0, `${cards.length} cards`);
  if (!cards.length) {
    console.log(results.join("\n"));
    console.log("\nERRORS:\n" + (errors.join("\n\n") || "(none captured — check script load order)"));
    process.exit(1);
  }
  check("one primary button per card", [...cards].every((c) => c.querySelectorAll(".start").length === 1));
  check("boots into list view", visible("list"));
  check("no boss battle markup", !html.includes("boss-list"));

  // Smart Start on the first card
  cards[0].querySelector(".start").click();
  await sleep(800);
  check("Smart Start → work view", visible("work"));
  check("work title set", $("work-title").textContent.length > 0, $("work-title").textContent);
  const steps = window.document.querySelectorAll("#steps .step");
  check("checklist generated", steps.length >= 3, `${steps.length} steps`);
  const msgs = window.document.querySelectorAll("#work-messages .msg");
  check("coach opened with a setup message", msgs.length >= 1, `${msgs.length} msgs`);
  check("assignment tab opened", created.length >= 1, created[0] || "");
  check("clock ticking", /^\d+:\d\d$/.test($("work-elapsed").textContent), $("work-elapsed").textContent);
  const active = store.activeSession;
  check("session persisted", Boolean(active && active.plannedMin));
  check("Ramp proposal with a why", active.chunkWhy?.length > 0 && active.chunkMin === active.plannedMin, `${active.plannedMin} min — ${active.chunkWhy}`);
  const chips = window.document.querySelectorAll("#chunk-chips button");
  check("chunk chips 5..25 with proposal selected", chips.length === 5 && [...chips].some((b) => b.classList.contains("active") && Number(b.textContent) === active.plannedMin));
  [...chips].find((b) => b.textContent === "10").click();
  await sleep(150);
  check("tapping a chip changes the chunk", store.activeSession.plannedMin === 10);

  // Chunk boundary → checkpoint message with actions. Backdate the start.
  store.activeSession.startedAt = Date.now() - 11 * 60000;
  store.activeSession.activityCount = 1; // the worker would have counted the assignment tab loading
  await window.eval("restoreClock()");
  await sleep(300);
  const cp = [...window.document.querySelectorAll("#work-messages .msg.k-checkpoint")];
  check("checkpoint posted at chunk boundary", cp.length === 1 && cp[0].querySelectorAll(".msg-actions button").length >= 2, cp[0]?.textContent.slice(0, 60));
  check("no paper mode (a tab was opened → activity)", store.activeSession.mode !== "paper" || store.activeSession.activityCount === 0);
  const firstBtn = cp[0]?.querySelector(".msg-actions button");
  firstBtn?.click(); // "step done ✓"
  await sleep(400);
  check("checkpoint action marks the current step", Object.values(store.assignmentMeta || {}).some((m) => (m.steps || [])[0]?.done === true));

  // Paper mode: a fresh boundary with zero tab activity and no doc
  store.activeSession.activityCount = 0;
  store.activeSession.paperChecked = false;
  store.activeSession.checkpointFor = null;
  store.activeSession.plannedMin = 5;
  await window.eval("restoreClock()");
  await sleep(300);
  check("paper mode detected when nothing on screen moved", store.activeSession.mode === "paper" && $("work-chunk").textContent.includes("paper"));

  // check a step, add a step, run a chip
  // Re-query: the checkpoint action re-rendered the checklist.
  const liveSteps = window.document.querySelectorAll("#steps .step");
  liveSteps[1].querySelector("input").click();
  await sleep(250);
  const meta = store.assignmentMeta || {};
  const saved = Object.values(meta).find((m) => Array.isArray(m.steps));
  check("step state saved to meta", Boolean(saved && saved.steps[1].done));
  $("step-input").value = "my own step";
  $("step-input").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await sleep(100);
  check("user step added", window.document.querySelectorAll("#steps .step").length === liveSteps.length + 1);
  window.document.querySelector('#work-chips [data-cmd="explain"]').click();
  await sleep(300);
  check("explain chip posts a message", window.document.querySelectorAll("#work-messages .msg").length > msgs.length);
  check("dev chips hidden by default", !window.document.body.classList.contains("dev"));

  // back to list keeps the clock, banner shows
  $("work-back").click();
  await sleep(50);
  await window.eval("refreshAll()");
  await sleep(200);
  check("resume banner while session runs", !$("resume-banner").classList.contains("hidden"), $("resume-banner").textContent);
  $("resume-banner").click();
  await sleep(300);
  check("banner returns to work view", visible("work"));

  // done
  $("work-done").click();
  await sleep(600);
  check("done ✓ → done view", visible("done"));
  check("session recorded with endedBy", (store.sessions || [])[0]?.endedBy === "user", JSON.stringify(store.sessions?.[0]?.endedBy));
  check("assignment marked done", Object.values(store.assignmentMeta || {}).some((m) => m.done));
  check("next card offered", !$("done-next").classList.contains("hidden"));
  $("done-close").click();
  check("done for now → list", visible("list"));

  // Worker-detected completion (portal flip) while a new session runs → done view
  window.document.querySelectorAll("#today-list .card")[0].querySelector(".start").click();
  await sleep(600);
  const runningId = store.activeSession?.assignmentId;
  store.activeSession = null; // the worker's endSession clears it before writing pendingDone
  await chrome.storage.local.set({ pendingDone: { assignmentId: runningId, title: "x", reason: "portal", record: { endedBy: "portal", actualMin: 7, plannedMin: 10 } } });
  await sleep(300);
  check("worker-ended session → done view", visible("done") && $("done-label").textContent.includes("myPoly"), $("done-label").textContent);
  check("pendingDone consumed", !store.pendingDone);
  $("done-close").click();

  // more view
  $("more-btn").click();
  check("▸more opens", visible("more"));
  check("stats rendered", window.document.querySelectorAll("#stat-cards .stat-card").length === 3);
  check("level box rendered", $("level-box").textContent.includes("Level"));
  $("more-btn").click();
  await sleep(100);
  check("◂ returns to list", visible("list"));

  // Ben's build: developer mode reveals the do-it-for-me chips + dev settings
  $("more-btn").click();
  $("dev-toggle").checked = true;
  $("dev-toggle").dispatchEvent(new window.Event("change", { bubbles: true }));
  await sleep(100);
  check("dev toggle flips body.dev + persists", window.document.body.classList.contains("dev") && store.settings?.devMode === true);
  check("dev chips present (4)", window.document.querySelectorAll("#work-chips .chat-chip.dev").length === 4);
  check("nightly + auto-done settings rows exist", Boolean($("nightly-toggle") && $("auto-done-toggle")));
  $("more-btn").click();
  await sleep(100);
  // Start a session and try 'write this step' with the rules brain → honest offline message, step NOT checked off
  window.document.querySelectorAll("#today-list .card")[0].querySelector(".start").click();
  await sleep(600);
  const before = window.document.querySelectorAll("#work-messages .msg").length;
  window.document.querySelector('#work-chips [data-cmd="dev-write"]').click();
  await sleep(400);
  const last = [...window.document.querySelectorAll("#work-messages .msg")].pop();
  check("dev write w/o brain → offline message, nothing faked", window.document.querySelectorAll("#work-messages .msg").length > before && /offline|bridge/i.test(last.textContent) && window.document.querySelectorAll("#steps .step.done").length === 0);
  $("work-stop").click();
  await sleep(400);
  check("stop → done view labelled stopped", visible("done") && /stopped/.test($("done-label").textContent));
  check("stop recorded as endedBy stop", store.sessions.some((s) => s.endedBy === "stop"));
  $("done-close").click();

  // time budget → inline plan
  window.document.querySelector('.time-chip[data-min="60"]').click();
  await sleep(300);
  check("time chip → inline plan", !$("plan-inline").classList.contains("hidden") && $("plan-inline").children.length > 0);

  console.log(results.join("\n"));
  if (errors.length) {
    console.log("\nERRORS:\n" + errors.join("\n\n"));
    process.exit(1);
  }
  const failed = results.filter((r) => r.startsWith("✗"));
  console.log(failed.length ? `\n${failed.length} FAILED` : "\nALL PASSED");
  process.exit(failed.length ? 1 : 0);
})();
