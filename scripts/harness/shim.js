/**
 * scripts/harness/shim.js - Fake chrome.* so the side panel runs as a plain
 * web page for eyeballing UI in a real browser (the jsdom smoke test can't
 * show you anything). Serve the repo root and open /scripts/harness/panel.html:
 *   python3 -m http.server 8766 --directory .
 * Storage is in-memory (window.__store); the fixture assignments are seeded.
 * The real bridge on 127.0.0.1:8000 is reachable only if it was started with
 * FA_ALLOW_ORIGINS=http://localhost:8766 (the bridge refuses web-page origins).
 */
const store = {};
const changeListeners = [];
const emit = (changes) => changeListeners.forEach((fn) => { try { fn(changes, "local"); } catch (e) { console.error("onChanged", e); } });
let seeded = Promise.resolve();
window.__seed = (p) => { seeded = p; };
window.__store = store;
window.__created = [];
window.chrome = {
  storage: {
    local: {
      async get(keys) {
        await seeded;
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
  permissions: { async request() { return true; }, async getAll() { return { origins: [] }; }, async contains() { return true; } },
  tabs: {
    async query() { return []; },
    async create(o) { window.__created.push(o.url); console.log("[shim] tabs.create", o.url); return { id: 1, url: o.url }; },
    async get() { return { id: 1 }; },
    async move() {},
    async update() {},
    async sendMessage() { throw new Error("no tab"); },
    async captureVisibleTab() { throw new Error("no captureVisibleTab in the harness"); },
    onUpdated: { addListener() {} },
    onActivated: { addListener() {} },
    onRemoved: { addListener() {} },
  },
  windows: { async create() { return { id: 2 }; }, async getCurrent() { return { id: 1 }; } },
  runtime: { async sendMessage() { return {}; }, getManifest: () => ({ version: "harness" }), getURL: (p) => "/" + p, onMessage: { addListener() {} }, lastError: null },
  scripting: { async insertCSS() {}, async executeScript() { throw new Error("no scripting in the harness"); } },
  identity: { getAuthToken: (o, cb) => cb && cb(undefined), async removeCachedAuthToken() {} },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  notifications: { create() {}, onButtonClicked: { addListener() {} }, onClicked: { addListener() {} } },
  sidePanel: { async setOptions() {}, async open() {} },
  idle: { queryState: (t, cb) => cb && cb("active"), onStateChanged: { addListener() {} } },
  contextMenus: { create() {}, onClicked: { addListener() {} } },
  offscreen: { async hasDocument() { return false; }, async createDocument() {} },
};
window.confirm = () => false;
