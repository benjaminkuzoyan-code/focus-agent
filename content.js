/**
 * content.js - Thin router that runs on every supported school portal.
 *
 * Detects which portal this page belongs to, delegates to that portal's
 * adapter (adapters/*.js are loaded before this file — see manifest.json),
 * and answers GET_ASSIGNMENTS messages with normalized Assignment objects.
 * Every successful fetch is also pushed to the background worker so the
 * side panel keeps working after the portal tab closes.
 */

// Version in the boot log so a stale (un-reloaded) build is obvious in DevTools.
console.log(
  `[Focus Agent] v${chrome.runtime.getManifest().version} content script loaded on:`,
  window.location.href
);

// A portal the student connected by hand (⚙ → connect my school) tells us
// which adapter to use on a domain we don't recognise (canvas.school.org).
const portalOverrideReady = chrome.storage.local.get("customPortals").then((o) => {
  FA.portalOverride = o.customPortals?.[location.origin] || null;
});
let lastFetch = { at: 0, count: 0, error: "" };

/** Pick the adapter whose matches() claims this host. */
function detectAdapter() {
  const host = window.location.hostname;
  for (const adapter of Object.values(FA.adapters)) {
    if (adapter.matches(host)) return adapter;
  }
  return null;
}

async function fetchNormalized() {
  await portalOverrideReady;
  const adapter = detectAdapter();
  if (!adapter) throw new Error(`No adapter for host: ${window.location.hostname}`);
  let assignments;
  try {
    assignments = await adapter.fetchAssignments();
    lastFetch = { at: Date.now(), count: assignments.length, error: "" };
  } catch (e) {
    lastFetch = { at: Date.now(), count: 0, error: e.message };
    throw e;
  }

  // Cache in the background so the side panel works away from this tab.
  chrome.runtime.sendMessage({
    type: "CACHE_ASSIGNMENTS",
    assignments,
    source: assignments[0]?.source ?? "unknown",
  }).catch(() => {}); // background may be asleep; the direct response still works

  return assignments;
}

/**
 * Build the full Student Snapshot (classes, grades, schedule, topics,
 * assignments) and cache it. One build per page load; GET_SNAPSHOT reuses
 * it unless the caller asks for fresh.
 */
let snapshotPromise = null;
function buildAndCacheSnapshot(force = false) {
  if (!snapshotPromise || force) {
    const adapter = detectAdapter();
    if (!adapter) return Promise.reject(new Error(`No adapter for host: ${window.location.hostname}`));
    snapshotPromise = FA.buildSnapshot(adapter).then(async (snap) => {
      await FA.saveSnapshot(snap);
      console.log(
        `[Focus Agent] snapshot: ${snap.classes.length} classes, ${snap.assignments.length} pending, ` +
          `${Object.values(snap.grades).flat().length} grades, ${snap.schedule.length} meetings` +
          (snap.errors.length ? ` — ${snap.errors.length} partial errors: ${snap.errors.join("; ")}` : "")
      );
      return snap;
    });
    snapshotPromise.catch(() => { snapshotPromise = null; }); // allow retry
  }
  return snapshotPromise;
}

// Warm the snapshot shortly after load, after the overlay has had first dibs
// on the network. Cheap: ~15 small JSON calls, all cookie-authenticated.
setTimeout(() => buildAndCacheSnapshot().catch((e) => console.warn("[Focus Agent] snapshot failed:", e.message)), 2500);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return;
  }
  if (message.type === "GET_ASSIGNMENTS") {
    fetchNormalized()
      .then((assignments) => sendResponse({ assignments }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // async response
  }
  if (message.type === "DETECT_PORTAL") {
    portalOverrideReady.then(() => {
      const d = FA.detectPortal();
      const adapter = detectAdapter();
      sendResponse({ ...d, adapter: adapter?.name || null, override: FA.portalOverride || null, lastFetch });
    });
    return true;
  }
  if (message.type === "MARK_COMPLETE") {
    // Ben's build: flip the portal's own "completed" checkbox. Throws until
    // the request is captured — see adapters/blackbaud.js markComplete.
    Promise.resolve(FA.adapters.blackbaud.markComplete(message.indexId))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === "GET_SNAPSHOT") {
    buildAndCacheSnapshot(Boolean(message.fresh))
      .then((snapshot) => sendResponse({ snapshot }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});
