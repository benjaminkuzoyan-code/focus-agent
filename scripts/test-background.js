/**
 * scripts/test-background.js - worker (background.js) alarm/lifecycle regression.
 *
 * Loads the REAL background.js in a Node VM with a fake chrome.* and a fake
 * FA.store, and asserts the hard-stop clock's lifecycle:
 *   - a session that survives a worker restart gets its alarms re-armed
 *     (onStartup / onInstalled) — the runaway-clock bug
 *   - SESSION_STARTED arms one alarm at the planned end
 *   - timeUp sets timeUpAt once and chimes once; a second fire does not chime again
 *   - timeUpWatch stops the session at the planned end after the grace period
 *   - extendSession moves the end and clears timeUpAt
 *   - a stop after the panel already ended the session does not throw
 *   - the worker never asks Google for an interactive sign-in
 * Run: node scripts/test-background.js   (exit 0 = all green)
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const root = path.resolve(__dirname, "..");
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  -- " + detail}`); };

function makeWorker({ activeSession = null } = {}) {
  const alarms = {}; const notifications = []; const messages = []; let chimes = 0;
  let session = activeSession; const sessions = [];
  const listeners = { startup: [], installed: [], alarm: [], message: [] };
  const google = { interactive: null, setInteractive(v) { google.interactive = v; }, isConnected: async () => false };
  const FA = {
    google,
    store: {
      async getActiveSession() { return session ? { ...session } : null; },
      async updateActiveSession(patch) { if (session) Object.assign(session, patch); },
      async getSettings() { return {}; },
      async getMeta() { return {}; },
      async endSession(endedBy, extra = {}) {
        if (!session) return null;
        const endedAt = extra.endedAt || Date.now();
        const rec = { endedBy, endedAt, actualMin: Math.max(1, Math.round((endedAt - session.startedAt) / 60000)), plannedMin: session.plannedMin, title: session.title };
        sessions.push(rec); session = null; return rec;
      },
      async addDistractionEvent() {}, async getSessions() { return sessions; }, async getCommitments() { return []; },
      async getCachedAssignments() { return []; }, async cacheAssignments() {}, async startSession() {},
    },
    coach: { negotiationLine: () => "" },
  };
  const storage = {};
  const chrome = {
    runtime: {
      onInstalled: { addListener: (f) => listeners.installed.push(f) }, onStartup: { addListener: (f) => listeners.startup.push(f) },
      onMessage: { addListener: (f) => listeners.message.push(f) }, getManifest: () => ({ version: "test" }), getURL: (p) => p,
      sendMessage: async (m) => { messages.push(m); if (m.type === "PLAY_CHIME") chimes++; },
    },
    alarms: { create: (name, opts) => { alarms[name] = opts; }, clear: (name) => { delete alarms[name]; }, get: async (n) => alarms[n] || null, onAlarm: { addListener: (f) => listeners.alarm.push(f) } },
    notifications: { create: (id, o) => notifications.push({ id, ...o }), clear() {}, onButtonClicked: { addListener() {} }, onClicked: { addListener() {} } },
    storage: { local: { get: async () => ({ ...storage }), set: async (o) => Object.assign(storage, o), remove: async (k) => { delete storage[k]; } }, onChanged: { addListener() {} } },
    tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, sendMessage: async () => { throw new Error("no tab"); }, create: async () => ({}), update: async () => ({}), get: async () => ({}) },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, updateContentScripts: async () => {}, unregisterContentScripts: async () => {}, executeScript: async () => {} },
    permissions: { getAll: async () => ({ origins: [] }), contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
    contextMenus: { create() {}, removeAll(cb) { cb && cb(); }, onClicked: { addListener() {} } },
    idle: { queryState: (t, cb) => cb("active"), onStateChanged: { addListener() {} } },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    sidePanel: { setPanelBehavior: () => ({ catch() {} }) },
    windows: { getCurrent: async () => ({ id: 1 }), create: async () => ({ id: 2 }) },
  };
  const ctx = vm.createContext({ chrome, FA, importScripts() {}, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Promise });
  // Real libs first (the worker calls FA.initCoach / ranking helpers at load), then our fakes win.
  for (const f of ["adapters/schema.js", "lib/priority.js", "lib/ai.js"]) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx);
  Object.assign(ctx.FA, { google, store: FA.store, coach: FA.coach });
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), ctx);
  return { ctx, alarms, notifications, chimes: () => chimes, listeners, session: () => session, sessions, storage, google };
}

(async () => {
  const now = Date.now();
  console.log("== B7: alarms re-armed for a session that survived a worker restart ==");
  {
    const w = makeWorker({ activeSession: { startedAt: now - 5 * 60000, plannedMin: 25, title: "Essay" } });
    for (const f of w.listeners.startup) await f();
    check("onStartup re-arms the time-up alarm at the planned end", Boolean(w.alarms["fa-checkin"]?.when) && Math.abs(w.alarms["fa-checkin"].when - (now - 5 * 60000 + 25 * 60000)) < 2000, JSON.stringify(w.alarms));
    check("onStartup re-arms the minute detector", w.alarms["fa-detect"]?.periodInMinutes === 1, JSON.stringify(w.alarms));
  }
  {
    const w = makeWorker({ activeSession: { startedAt: now - 5 * 60000, plannedMin: 25, title: "Essay" } });
    for (const f of w.listeners.installed) await f({ reason: "update" });
    check("onInstalled (extension update) re-arms both alarms", Boolean(w.alarms["fa-checkin"]) && Boolean(w.alarms["fa-detect"]), JSON.stringify(w.alarms));
  }
  {
    const w = makeWorker();
    for (const f of w.listeners.startup) await f();
    check("no session → nothing armed", !w.alarms["fa-checkin"] && !w.alarms["fa-detect"], JSON.stringify(w.alarms));
  }

  console.log("== time-up lifecycle ==");
  {
    const w = makeWorker({ activeSession: { startedAt: now - 25 * 60000 - 1000, plannedMin: 25, title: "Essay" } });
    await w.ctx.timeUp(w.session());
    check("timeUp sets timeUpAt once", typeof w.session().timeUpAt === "number", JSON.stringify(w.session()));
    check("timeUp chimes once and notifies", w.chimes() === 1 && w.notifications.some((n) => n.id.startsWith("fa-timeup-")), `chimes=${w.chimes()}`);
    const first = w.session().timeUpAt;
    await w.ctx.timeUp(w.session());
    check("second timeUp (alarm + watchdog) does NOT chime again or move timeUpAt", w.chimes() === 1 && w.session().timeUpAt === first, `chimes=${w.chimes()}`);
    await w.ctx.timeUpWatch();
    check("timeUpWatch inside the grace period leaves the session running", w.session() !== null);
    w.session().timeUpAt = Date.now() - 46 * 1000;
    await w.ctx.timeUpWatch();
    check("timeUpWatch after 45 s stops at the planned end (25 min logged, not 25+)", w.session() === null && w.sessions[0]?.endedBy === "timeup" && w.sessions[0].actualMin === 25, JSON.stringify(w.sessions[0]));
    check("stop writes pendingDone with reason timeup", w.storage.pendingDone?.reason === "timeup", JSON.stringify(w.storage.pendingDone));
  }
  {
    const w = makeWorker({ activeSession: { startedAt: now - 25 * 60000, plannedMin: 25, title: "Essay", timeUpAt: now } });
    await w.ctx.extendSession(w.session(), 5);
    check("extendSession +5 clears timeUpAt and re-arms the end alarm", w.session().timeUpAt === 0 && w.session().plannedMin === 30 && Boolean(w.alarms["fa-checkin"]?.when), JSON.stringify(w.session()));
  }
  {
    const w = makeWorker({ activeSession: { startedAt: now - 10 * 60000, plannedMin: 25, title: "Essay" } });
    for (const f of w.listeners.message) { await new Promise((res) => { const r = f({ type: "SESSION_STARTED", checkinMin: 25 }, {}, () => res()); if (r !== true) res(); }); }
    check("SESSION_STARTED arms ONE alarm at startedAt + plannedMin (no repeating check-in)", Boolean(w.alarms["fa-checkin"]?.when) && !w.alarms["fa-checkin"].periodInMinutes, JSON.stringify(w.alarms["fa-checkin"]));
  }
  {
    const w = makeWorker({ activeSession: { startedAt: now - 30 * 60000, plannedMin: 25, title: "Essay" } });
    const s = w.session();
    await w.ctx.FA.store.endSession("user"); // the panel got there first
    let threw = false;
    try { await w.ctx.stopSession(s, "timeup", now); } catch (e) { threw = true; }
    check("stopSession after the panel already ended it does not throw and writes no pendingDone", !threw && !w.storage.pendingDone, `threw=${threw}`);
  }
  {
    const w = makeWorker();
    check("worker disables interactive Google sign-in at load", w.google.interactive === false, String(w.google.interactive));
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
