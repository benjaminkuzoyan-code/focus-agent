/**
 * scripts/smoke-panel.js - Boot the side panel in jsdom with a fake chrome.*
 * API and click through list → Smart Start → work → done. Not a unit test —
 * a "does it even load" gate. Run: NODE_PATH=<dir with jsdom> node scripts/smoke-panel.js
 * (jsdom is not a project dependency; `npm i jsdom` anywhere and point NODE_PATH at it).
 */const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const path = require("path");
const { webcrypto } = require("node:crypto");
const googleAuthOnly = process.argv.includes("--google-auth");
const authEffects = [];
let authDoor = "chrome";
let authFailure = null;
let docStatus = 200;

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
      async remove(k) {
        const changes = {};
        for (const x of Array.isArray(k) ? k : [k]) { changes[x] = { oldValue: store[x] }; delete store[x]; }
        emit(changes);
      },
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
  runtime: { async sendMessage() { return {}; }, getManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")), getURL: (p) => "chrome-extension://test/" + p },
  scripting: { async insertCSS() {}, async executeScript() {} },
  identity: {
    getAuthToken(o, cb) {
      authEffects.push(["chrome", o]);
      if (authDoor === "web") chrome.runtime.lastError = { message: "Service has been disabled for this account." };
      cb(googleAuthOnly && authDoor === "chrome" ? "synthetic-chrome-token" : undefined);
      delete chrome.runtime.lastError;
    },
    getRedirectURL: () => "https://synthetic.chromiumapp.org/",
    launchWebAuthFlow(o, cb) {
      authEffects.push(["web", o]);
      const request = new URL(o.url);
      const fields = authFailure ? { error: authFailure } : { access_token: "synthetic-web-token", token_type: "Bearer", expires_in: "3600" };
      cb(googleAuthOnly ? "https://synthetic.chromiumapp.org/#" + new URLSearchParams({ state: request.searchParams.get("state"), ...fields }) : undefined);
    },
    removeCachedAuthToken(o, cb) { authEffects.push(["forget", o]); cb(); },
  },
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
    Object.defineProperty(window, "crypto", { value: webcrypto });
    window.fetch = async (url, options) => {
      if (googleAuthOnly && url.startsWith("https://docs.googleapis.com/")) {
        authEffects.push(["docs", options]);
        if (docStatus === "offline") throw new Error("PRIVATE offline failure");
        return { ok: docStatus === 200, status: docStatus, json: async () => ({ documentId: "synthetic-doc", title: "Auth tracer", error: { message: "PRIVATE provider failure" } }) };
      }
      throw new Error("offline");
    };
    window.confirm = () => false;
    window.navigator.clipboard = { writeText: async () => {} };
    window.scrollTo = () => {};
  },
});
const { window } = dom;

// Seed the assignment cache from the test fixture (the extension itself has
// no demo data any more): schema + fixture into the window, run the fixture,
// then pretend the portal cached it a moment ago.
window.eval(fs.readFileSync(path.join(ROOT, "adapters/schema.js"), "utf8"));
window.eval(fs.readFileSync(path.join(ROOT, "scripts/fixtures/mock-assignments.js"), "utf8"));
const seeded = (async () => {
  const items = await window.FA.adapters.mock.fetchAssignments();
  store.assignmentsCache = { items, fetchedAt: Date.now(), source: "blackbaud" };
  // The coach is silent unless spoken to by default (v0.8.19); this flow checks the setup message, so let it speak.
  store.settings = { ...(store.settings || {}), coachSpeaksUp: true };
})();

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
  await seeded;
  await sleep(2500); // boot: initCoach health check times out at 1.5s, then loads the cached fixture

  const results = [];
  const check = (name, ok, extra = "") => results.push(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);

  if (googleAuthOnly) {
    check("clean boot shows disconnected without a chooser", $("google-btn").textContent === "connect G" && !authEffects.some(e => e[1]?.interactive));
    authEffects.length = 0;
    $("google-btn").click();
    $("google-btn").click();
    await sleep(100);
    check("actual Chrome button tracer persists and renders connected", store.googleAuthState?.status === "connected" && $("google-btn").textContent === "G ✓ connected");
    check("simultaneous actual clicks connect only once", authEffects.filter(e => e[0] === "chrome" && e[1].interactive).length === 1);
    const doc = await window.FA.google.getDoc("synthetic-doc");
    check("actual Chrome tracer authenticates Docs", doc.title === "Auth tracer" && authEffects.find(e => e[0] === "docs")?.[1].headers.Authorization === "Bearer synthetic-chrome-token");
    authEffects.length = 0;
    // Boot a second actual panel with fresh script globals and the persisted store.
    async function reloadedChip() {
    const reopened = new JSDOM(html, {
      url: "chrome-extension://test/sidepanel/panel.html", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(w) {
        w.chrome = chrome;
        w.fetch = window.fetch;
        Object.defineProperty(w, "crypto", { value: webcrypto });
        w.confirm = () => false;
        w.navigator.clipboard = { writeText: async () => {} };
        w.scrollTo = () => {};
      },
    });
    const listenerCount = changeListeners.length;
    for (const src of srcs) reopened.window.eval(fs.readFileSync(path.join(ROOT, "sidepanel", src), "utf8"));
    await sleep(1800);
    const label = reopened.window.document.getElementById("google-btn").textContent;
    changeListeners.splice(listenerCount);
    reopened.window.close();
    return label;
    }
    check("persisted status renders after reload without identity calls", await reloadedChip() === "G ✓ connected" && authEffects.length === 0);
    await chrome.storage.local.set({ googleAuthState: { version: 1, status: "disconnected", selectedDoor: null, everConnected: true, reason: null } });
    await sleep(30);
    check("storage notification updates actual chip", $("google-btn").textContent === "connect G");
    authDoor = "web";
    authEffects.length = 0;
    $("google-btn").click();
    await sleep(100);
    check("actual personal-account tracer persists and renders connected", store.googleAuthState?.selectedDoor === "web" && $("google-btn").textContent === "G ✓ connected");
    check("disabled Chrome opens exactly one personal chooser", authEffects.filter(e => e[0] === "chrome").length === 1 && authEffects.filter(e => e[0] === "web" && e[1].interactive).length === 1);
    await window.FA.google.getDoc("synthetic-doc");
    check("actual personal-account tracer authenticates Docs", authEffects.find(e => e[0] === "docs")?.[1].headers.Authorization === "Bearer synthetic-web-token");
    docStatus = 401;
    authEffects.length = 0;
    let failure;
    try { await window.FA.google.getDoc("synthetic-doc"); } catch (e) { failure = e; }
    await sleep(50);
    check("terminal feature failure renders accessible Reconnect Google", failure?.category === "authorization" && $("google-btn").textContent === "Reconnect Google" && $("google-btn").getAttribute("aria-label") === "Reconnect Google" && $("google-btn").title.includes("consent") && $("google-note").textContent.includes("pilot"));
    check("feature failure retries once without interactive escalation", authEffects.filter(e => e[0] === "docs").length === 2 && authEffects.filter(e => e[0] === "web").every(e => !e[1].interactive));
    authEffects.length = 0;
    check("reconnect persists across actual panel reload without identity probes", await reloadedChip() === "Reconnect Google" && authEffects.length === 0);
    authFailure = "access_denied";
    const priorNotice = $("forecast-headline").textContent;
    $("google-btn").click(); $("google-btn").click();
    await sleep(100);
    check("cancelled reconnect stays reconnect without scary copy or duplicate chooser", $("google-btn").textContent === "Reconnect Google" && $("forecast-headline").textContent === priorNotice && authEffects.filter(e => e[0] === "web" && e[1].interactive).length === 1);
    authFailure = "network offline";
    $("google-btn").click();
    await sleep(100);
    check("offline reconnect offers retry while retaining reconnect state", $("google-btn").textContent === "Reconnect Google" && /connection.*try again/i.test($("forecast-headline").textContent));
    authFailure = null; docStatus = 200; authEffects.length = 0;
    $("google-btn").click(); $("google-btn").click();
    await sleep(100);
    const recovered = await window.FA.google.getDoc("synthetic-doc");
    check("explicit reconnect restores real-module Docs access and clears marker", recovered.title === "Auth tracer" && store.googleAuthState.status === "connected" && store.googleAuthState.reason === null && $("google-btn").textContent === "G ✓ connected" && authEffects.filter(e => e[0] === "web" && e[1].interactive).length === 1);
    for (const [code, category] of [[403, "resource"], ["offline", "network"]]) {
      docStatus = code;
      try { await window.FA.google.getDoc("synthetic-doc"); } catch (e) { failure = e; }
      await sleep(30);
      check(`${category} feature failure never invents expiry or leaks provider text`, failure.category === category && $("google-btn").textContent === "G ✓ connected" && !window.document.body.textContent.includes("PRIVATE"));
    }
    window.confirm = () => true;
    $("google-btn").click();
    await sleep(100);
    check("explicit disconnect clears state despite offline revocation", $("google-btn").textContent === "connect G" && !store.googleWebToken && store.googleAuthState.selectedDoor === null);
    authEffects.length = 0;
    check("disconnected reload neither probes nor reconnects", await reloadedChip() === "connect G" && authEffects.length === 0);
    await chrome.storage.local.set({ googleAuthState: { version: 1, status: "reconnect", selectedDoor: "web", everConnected: true, reason: "authorization" } });
    await sleep(30);
    await chrome.storage.local.remove("googleAuthState");
    await sleep(30);
    check("status deletion rerenders without an identity or storage loop", $("google-btn").textContent === "connect G" && authEffects.length === 0);
    check("real panel scripts loaded without errors", errors.length === 0, errors.join(" | "));
    console.log(results.join("\n"));
    results.forEach((r, i) => console.log(`${r.startsWith("✓") ? "ok" : "not ok"} ${i + 1} - ${r.slice(2)}`));
    console.log(`1..${results.length}\n# tests ${results.length}\n# pass ${results.filter(r => r.startsWith("✓")).length}\n# fail ${results.filter(r => r.startsWith("✗")).length}`);
    const ok = results.length > 0 && !results.some(r => r.startsWith("✗"));
    console.log(`${results.length} executed Google auth smoke cases`);
    console.log(ok ? "GOOGLE AUTH PASSED" : "GOOGLE AUTH FAILED");
    window.close();
    process.exit(ok ? 0 : 1);
  }

  const cards = window.document.querySelectorAll("#today-list .card");
  check("list renders cached assignments (fixture)", cards.length > 0, `${cards.length} cards`);
  if (!cards.length) {
    console.log(results.join("\n"));
    console.log("\nERRORS:\n" + (errors.join("\n\n") || "(none captured — check script load order)"));
    process.exit(1);
  }
  check("one primary button per card", [...cards].every((c) => c.querySelectorAll(".start").length === 1));
  check("boots into list view", visible("list"));
  check("no boss battle markup", !html.includes("boss-list"));

  // Missing / overdue work is pinned first, in its own section, badged.
  const behindHeader = window.document.querySelector("#today-list .list-section.behind");
  check("missing/overdue section pinned at the top", Boolean(behindHeader) && behindHeader.textContent.includes("missing / overdue"), behindHeader?.textContent.slice(0, 50) || "(no section)");
  const firstBadge = cards[0].querySelector(".badge-behind");
  check("teacher-flagged MISSING item is the first card", firstBadge?.textContent === "MISSING" && cards[0].textContent.includes("Dunbar-Ortiz"), cards[0].querySelector(".card-title")?.textContent);
  check("overdue item is badged and above everything due later", cards[1].querySelector(".badge-behind")?.textContent === "OVERDUE", cards[1].querySelector(".card-title")?.textContent);
  check("the pick hero is the missing one", $("pick-title").textContent.includes("Dunbar-Ortiz"), $("pick-title").textContent);
  const fin = window.document.querySelector("#today-list .finished-section");
  check("graded + stale-overdue work sit folded at the bottom, not in the ranking", Boolean(fin) && fin.textContent.includes("(2)") && ![...cards].some((c) => c.textContent.includes("Syllabus quiz") || c.textContent.includes("Appiah")), fin?.querySelector("summary")?.textContent);
  check("only the recent overdue item is 'behind' (3-week-old one is stale, not overdue)", [...window.document.querySelectorAll("#today-list .card .badge-behind")].length === 2, String([...window.document.querySelectorAll("#today-list .card .badge-behind")].length));

  // Smart Start on the first card (the missing one, with two attached links)
  cards[0].querySelector(".start").click();
  await sleep(800);
  check("Smart Start → work view", visible("work"));
  check("Smart Start opened BOTH attached links", created.includes("https://docs.google.com/document/d/mock-worksheet/edit") && created.includes("https://en.wikipedia.org/wiki/Culture_of_Conquest"), created.join(" | "));
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
  check("dev chips present (6)", window.document.querySelectorAll("#work-chips .chat-chip.dev").length === 6);
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

  // Files box: attach a URL (no tab open → recorded with an honest error), persists per assignment
  window.document.querySelectorAll("#today-list .card")[0].querySelector(".start").click();
  await sleep(600);
  await window.eval("attachUrl('https://reading.example.edu/ch3', 'Chapter 3')");
  await sleep(200);
  const fchips = window.document.querySelectorAll("#files-list .file-chip");
  check("files box shows the attached reading", fchips.length >= 1 && fchips[0].textContent.includes("Chapter 3"));
  check("attached file persisted in assignment meta", Object.values(store.assignmentMeta).some((m) => (m.files || []).some((f) => f.url === "https://reading.example.edu/ch3")));
  const dup = await window.eval("attachUrl('https://reading.example.edu/ch3#frag', 'Chapter 3')");
  check("same URL not attached twice", dup === null && window.document.querySelectorAll("#files-list .file-chip").length === fchips.length);
  // docops in a reply: student build strips the block and never writes
  const out = await window.eval("applyDocOpsFromReply('Done.\\n```docops\\n{\"ops\":[{\"type\":\"append\",\"text\":\"x\"}],\"summary\":\"added x\"}\\n```', {id:null}, false)");
  check("student build: docops block stripped, nothing written", out.trim() === "Done." || /no doc/.test(out));
  const out2 = await window.eval("applyDocOpsFromReply('Writing it now.\\n```docops\\n{\"ops\":[{\"type\":\"append\",\"text\":\"x }\"}],\"summary\":\"s\"}', {id:null}, false)");
  check("docops parsed even without a closing fence (brace-matched, string-safe)", out2.trim() === "Writing it now." || /no doc/.test(out2), out2.slice(0, 60));
  $("work-stop").click();
  await sleep(300);
  $("done-close").click();

  // Chat hygiene + study mode
  const cardsAll = [...window.document.querySelectorAll("#today-list .card")];
  const titles = cardsAll.map((c) => c.querySelector(".card-title").textContent);
  const testIdx = titles.findIndex((x) => /UNIT TEST|quiz|exam/i.test(x)); // not "test corrections" (homework)
  check("fixture has a test to study for", testIdx >= 0, titles.join(" | ").slice(0, 80));
  cardsAll[testIdx >= 0 ? testIdx : 0].querySelector(".start").click();
  await sleep(600);
  check("study chips visible for a test", window.document.body.classList.contains("studying") && window.getComputedStyle(window.document.querySelector('[data-cmd="quiz"]')).display !== "none");
  // attach a local text file the way a drop would (also exercises the local-file path)
  await window.eval('attachLocalFiles([new File(["The Treaty of Versailles was the agreement that ended World War I in 1919. Reparations are payments a defeated country makes to the winners."], "notes.txt", {type:"text/plain"})])');
  await sleep(300);
  const localChip = window.document.querySelector("#files-list .file-chip");
  check("local file attached and read", localChip && Object.values(store.assignmentMeta).some((m) => (m.files || []).some((f) => f.kind === "local" && f.chars > 50)), localChip ? localChip.title : "no chip");
  window.document.querySelector('[data-cmd="flashcards"]').click();
  await sleep(500);
  const cardEls = window.document.querySelectorAll("#work-messages .fcard");
  check("rules flashcards built from definition sentences", cardEls.length >= 1, `${cardEls.length} cards`);
  cardEls[0]?.click();
  check("card flips", cardEls[0]?.classList.contains("flip"));
  window.document.querySelector('[data-cmd="studyplan"]').click();
  await sleep(400);
  check("study plan adds dated steps", [...window.document.querySelectorAll("#steps .step-text")].some((s) => s.textContent.startsWith("📅")));
  const msgsBefore = window.document.querySelectorAll("#work-messages .msg").length;
  window.document.querySelector('[data-cmd="clear"]').click();
  await sleep(150);
  check("clear chat empties the thread", window.document.querySelectorAll("#work-messages .msg").length === 0 && msgsBefore > 0);
  const tid = store.activeSession.assignmentId;
  await window.eval("pushCoach('hello')");
  const shortMsg = [...window.document.querySelectorAll("#work-messages .msg")].pop();
  check("short coach reply is not folded", shortMsg && !shortMsg.querySelector(".msg-more") && shortMsg.querySelector(".msg-text")?.textContent === "hello");
  await window.eval(`pushCoach(${JSON.stringify(Array.from({ length: 20 }, (_, i) => "line " + i).join("\n\n\n"))})`);
  const longMsg = [...window.document.querySelectorAll("#work-messages .msg")].pop();
  check("long coach reply folded with show more", Boolean(longMsg?.querySelector(".msg-text.clamp")) && Boolean(longMsg?.querySelector(".msg-more")), longMsg?.querySelector(".msg-more")?.textContent);
  check("blank-line padding collapsed in the bubble", !/\n{3}/.test(longMsg?.querySelector(".msg-text")?.textContent || "\n\n\n"));
  longMsg?.querySelector(".msg-more")?.click();
  check("show more expands in place", longMsg?.querySelector(".msg-text")?.classList.contains("expanded"));
  $("work-done").click();
  await sleep(500);
  check("finishing an assignment clears its chat log", (store.assignmentMeta[tid].thread || []).length === 0);
  check("…but keeps its files", (store.assignmentMeta[tid].files || []).length >= 1);
  $("done-close").click();
  // a non-test assignment hides study chips
  const other = cardsAll.findIndex((c, i) => i !== testIdx && !/test|quiz|exam/i.test(c.querySelector(".card-title").textContent));
  window.document.querySelectorAll("#today-list .card")[0].querySelector(".start").click();
  await sleep(500);
  check("study chips hidden for non-test work", !window.document.body.classList.contains("studying") || /test|quiz|exam/i.test($("work-title").textContent));
  check("Smart Start clears the general chat", (store.chatHistory || []).length === 0);
  $("work-stop").click();
  await sleep(300);
  $("done-close").click();
  check("settings: connect my school + debug info present", Boolean($("connect-portal-btn") && $("debug-btn")));

  // Writing voice: samples → stats profile → available to writing prompts
  check("voice section present", Boolean($("voice-list") && $("voice-import-guide") && $("voice-auto-toggle")));
  const sample = "I finished the code, and it passed all tests. Although the bug was tricky, I managed to fix it; the missing dependency had hidden in a config file nobody read. When the tests failed, I investigated the issue, and I discovered the cause within an hour. Therefore the fix was small, but the lesson was not. Moreover, the experience taught me to read the config first. I now check dependencies before I write a single line, and I keep notes so the next person does not repeat my mistake. Consequently my debugging time dropped by half over the semester.";
  const added = await window.eval(`FA.voice.addSample({ title: "Debugging essay", text: ${JSON.stringify(sample)}, source: "paste" })`);
  check("sample stored (≥80 words)", added && (store.voiceSamples || []).length === 1);
  const rejected = await window.eval(`FA.voice.addSample({ title: "tiny", text: "too short", source: "paste" })`);
  check("too-short sample rejected", rejected === null);
  const prof = await window.eval("FA.voice.rebuild()");
  check("stats profile built offline", prof && /sentences average \d+ words/.test(prof.traits[0]) && prof.traits.some((x) => /semicolon/.test(x)));
  const pkg = await window.eval("FA.voice.forBrain()");
  check("voice package for prompts has profile + excerpt", pkg && pkg.profile.length > 10 && pkg.excerpts.length === 1 && pkg.sampleCount === 1);
  await window.eval("renderVoice()");
  await sleep(100);
  check("voice chip rendered in settings", window.document.querySelectorAll("#voice-list .file-chip").length === 1);

  // "open the module" actually opens the module
  const r1 = await window.eval("FA.resolveOpens({opens:[], focus:'Reread the module before answering', gather:['Unit 1 Notes']}, {topics:[{name:'Unit 1 Notes', url:'u1', published:'2026-09-01'},{name:'Syllabus', url:'u0', published:'2026-08-20'}], links:[{text:'Reading packet', url:'l0'}], description:''})");
  check("plan text naming a topic → it opens", r1.opens.some((o) => o.kind === "topic" && o.i === 0), JSON.stringify(r1.opens));
  const r2 = await window.eval("FA.resolveOpens({opens:[], focus:'open the module and start', gather:[]}, {topics:[{name:'Old Unit', url:'a', published:'2026-08-01'},{name:'New Unit', url:'b', published:'2026-09-01'}], links:[], description:''})");
  check("'the module' with no name → latest topic", r2.opens.length === 1 && r2.opens[0].i === 1);
  const r3 = await window.eval("FA.resolveOpens({opens:[], focus:'x', gather:[]}, {topics:[{name:'T', url:'a'}], links:[{text:'A', url:'1'},{text:'B', url:'2'}], description:''}, {aggressive:true})");
  check("autopilot opens every link + a topic", r3.opens.filter((o) => o.kind === "link").length === 2 && r3.opens.some((o) => o.kind === "topic"));
  check("autopilot chip + setting exist (dev)", Boolean(window.document.querySelector('[data-cmd="dev-autopilot"]') && $("autopilot-toggle")));

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
