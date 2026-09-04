/**
 * background.js - Service worker: alarms, check-ins, and the distraction watcher.
 *
 * Three jobs:
 *   1. Check-ins  — during a focus session, periodically ask "still on it?"
 *   2. Watcher    — during a focus session, notice drifts to distracting
 *                   sites and send a negotiation (not a block) with receipts
 *   3. Receipts   — commitment deadlines fire a "you said 4pm" notification
 *
 * The Coach brain lives in lib/ai.js; when the Claude API key + backend
 * exist, ClaudeCoach replaces MockCoach there and this file doesn't change.
 */

importScripts(
  "adapters/schema.js",
  "lib/storage.js",
  "lib/priority.js",
  "lib/snapshot.js",
  "lib/docops.js",
  "lib/google.js",
  "lib/ai.js"
);

const CHECKIN_ALARM = "fa-checkin";
const DETECT_ALARM = "fa-detect";       // completion detection, every minute during a session
const DOC_STALE_MS = 8 * 60 * 1000;     // a doc untouched this long → "looks finished?"
const COMMITMENT_ALARM = "fa-commitments";
const NUDGE_COOLDOWN_MS = 2 * 60 * 1000; // at most one negotiation per 2 min

const DISTRACTOR_PATTERNS = [
  /youtube\.com/, /tiktok\.com/, /instagram\.com/, /twitter\.com/, /x\.com/,
  /reddit\.com/, /netflix\.com/, /twitch\.tv/, /discord\.com/, /pinterest\.com/,
];

/* ------------------------------------------------------------------ *
 * Selection toolbar on granted sites
 *
 * Highlight → Annotate · Summarize · Ask runs on any origin the student
 * granted (optional_host_permissions; the panel asks at Smart Start for
 * the assignment's own links). We register it as a dynamic content script
 * for exactly those origins, so it's there on every visit — not just the
 * tab Smart Start opened.
 * ------------------------------------------------------------------ */
const TOOLBAR_SCRIPT_ID = "fa-selection-toolbar";

async function syncToolbarScript() {
  let origins = [];
  try {
    const all = await chrome.permissions.getAll();
    origins = (all.origins || []).filter((o) => /^https?:\/\//.test(o));
  } catch {
    return;
  }
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [TOOLBAR_SCRIPT_ID] });
    if (!origins.length) {
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [TOOLBAR_SCRIPT_ID] });
      return;
    }
    const def = { id: TOOLBAR_SCRIPT_ID, matches: origins, js: ["annotate/selection-toolbar.js"], runAt: "document_idle", persistAcrossSessions: true };
    if (existing.length) await chrome.scripting.updateContentScripts([def]);
    else await chrome.scripting.registerContentScripts([def]);
    console.log(`[Focus Agent] selection toolbar registered on ${origins.length} origin pattern(s)`);
  } catch (e) {
    console.warn("[Focus Agent] toolbar registration failed:", e.message);
  }
}
chrome.permissions.onAdded.addListener(syncToolbarScript);
chrome.permissions.onRemoved.addListener(syncToolbarScript);
chrome.runtime.onStartup.addListener(syncToolbarScript);

// The worker answers COACH_CALL for content scripts, so it needs the real
// brain when the bridge is up. Re-check at most once a minute.
let lastBrainCheck = 0;
async function ensureBrain() {
  if (FA.coachBrain === "claude" || Date.now() - lastBrainCheck < 60000) return;
  lastBrainCheck = Date.now();
  await FA.initCoach().catch(() => {});
}
ensureBrain();

/** Which coach methods a content script may call, and how their args map. */
const COACH_METHODS = {
  summarize: (p) => [p.text, { title: p.title }],
  annotateQuestion: (p) => [p.quote, { title: p.title, url: p.url }],
  askPassage: (p) => [p.quote, p.question, { title: p.title, url: p.url }],
};

// Right-click → "Highlight with Focus Agent" on any page or PDF link.
function ensureContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: "fa-highlight-here", title: "Highlight with Focus Agent (annotate · summarize · ask)", contexts: ["page", "selection"] });
      chrome.contextMenus.create({ id: "fa-open-pdf", title: "Open PDF in Focus Agent viewer", contexts: ["link"], targetUrlPatterns: ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.PDF", "*://drive.google.com/file/d/*"] });
    });
  } catch (e) {
    console.log("[Focus Agent] context menu:", e.message);
  }
}
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "fa-open-pdf" && info.linkUrl) {
    const drive = info.linkUrl.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
    const file = drive ? `https://drive.google.com/uc?export=download&id=${drive[1]}` : info.linkUrl;
    chrome.tabs.create({ url: chrome.runtime.getURL("viewer/pdfjs/web/viewer.html") + "?file=" + encodeURIComponent(file) });
    return;
  }
  if (info.menuItemId === "fa-highlight-here" && tab?.id) {
    if (/\.pdf($|[?#])/i.test(tab.url || "") && !tab.url.includes("/viewer/pdfjs/")) {
      chrome.tabs.update(tab.id, { url: chrome.runtime.getURL("viewer/pdfjs/web/viewer.html") + "?file=" + encodeURIComponent(tab.url) });
      return;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["annotate/selection-toolbar.js"] });
    } catch (e) {
      console.log("[Focus Agent] can't inject toolbar here:", e.message);
    }
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[Focus Agent] v${chrome.runtime.getManifest().version} installed (${details.reason}).`);
  syncToolbarScript();
  ensureContextMenu();
  // (The cached assignment list is deliberately KEPT across reloads — a
  // slightly stale list beats demo data while portal tabs reconnect.)
  // Re-inject content scripts into portal tabs that are already open.
  // Chrome drops them on reload ("Receiving end does not exist"), which
  // otherwise leaves the panel on demo data until every tab is refreshed.
  reinjectContentScripts();
  // Poll commitments every minute so receipts arrive on time.
  chrome.alarms.create(COMMITMENT_ALARM, { periodInMinutes: 1 });
});

const PORTAL_MATCHES = ["https://*.blackbaud.com/*", "https://*.myschoolapp.com/*", "https://*.instructure.com/*", "https://classroom.google.com/*", "http://localhost:8000/*"];
const CONTENT_JS = ["adapters/schema.js", "adapters/blackbaud.js", "adapters/canvas.js", "adapters/classroom.js", "adapters/mock.js", "adapters/demo.js", "lib/priority.js", "lib/snapshot.js", "lib/ai.js", "content.js", "overlay/coach-overlay.js"];
const CONTENT_CSS = ["overlay/coach-overlay.css"];

async function reinjectContentScripts() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: PORTAL_MATCHES });
  } catch {
    return;
  }
  let injected = 0;
  for (const tab of tabs) {
    if (!tab.id) continue;
    // Skip tabs whose content script is alive — injecting twice would
    // double the overlay bubble and the message listeners.
    try {
      const pong = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
      if (pong?.ok) continue;
    } catch {
      /* no listener = needs injection */
    }
    try {
      injected++;
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: CONTENT_CSS });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_JS });
    } catch (e) {
      // Discarded/unloaded tabs and chrome:// pages can't be injected; fine.
      console.log("[Focus Agent] could not re-inject into", tab.url, e.message);
    }
  }
  console.log(`[Focus Agent] re-injected content scripts into ${injected}/${tabs.length} portal tab(s)`);
  return injected;
}

/* ------------------------------------------------------------------ *
 * Messages from the side panel / popup / content scripts
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "REINJECT": {
        // Side panel found portal tabs without a content script (typical
        // right after an extension reload). Re-inject and report.
        const n = await reinjectContentScripts();
        sendResponse({ ok: true, tabs: n });
        break;
      }

      case "CACHE_ASSIGNMENTS":
        await FA.store.cacheAssignments(message.assignments, message.source);
        sendResponse({ ok: true });
        break;

      case "SESSION_STARTED": {
        const settings = await FA.store.getSettings();
        chrome.alarms.create(CHECKIN_ALARM, {
          periodInMinutes: message.checkinMin || settings.checkinMin,
        });
        chrome.alarms.create(DETECT_ALARM, { periodInMinutes: 1 });
        detectTick = 0;
        sendResponse({ ok: true });
        break;
      }

      case "SESSION_ENDED":
        chrome.alarms.clear(CHECKIN_ALARM);
        chrome.alarms.clear(DETECT_ALARM);
        sendResponse({ ok: true });
        break;

      case "GET_COACH_STATE": {
        // The page overlay sends the assignments it just fetched; we rank
        // them against stored session history and return the coach's pick,
        // so the overlay can badge the actual portal rows.
        const [meta, sessions] = await Promise.all([
          FA.store.getMeta(),
          FA.store.getSessions(),
        ]);
        const ranked = FA.rankAssignments(message.assignments || [], meta, sessions);
        const pick = FA.coach.pick(ranked);
        const activeSession = await FA.store.getActiveSession();
        sendResponse({ ranked, pick, activeSession });
        break;
      }

      case "START_SESSION_FROM_PAGE": {
        // Coach bubble's "Start focus" — same Ramp proposal the panel uses.
        const a = message.assignment;
        const sessions = await FA.store.getSessions();
        const { minutes, why } = FA.proposeChunk(sessions, a);
        await FA.store.startSession(a, minutes, { chunkWhy: why });
        chrome.alarms.create(CHECKIN_ALARM, { periodInMinutes: minutes });
        chrome.alarms.create(DETECT_ALARM, { periodInMinutes: 1 });
        detectTick = 0;
        sendResponse({ ok: true, plannedMin: minutes });
        break;
      }

      case "END_SESSION_FROM_PAGE": {
        chrome.alarms.clear(CHECKIN_ALARM);
        chrome.alarms.clear(DETECT_ALARM);
        const record = await FA.store.endSession("user");
        sendResponse({ ok: true, record });
        break;
      }

      case "COACH_CALL": {
        // Content scripts can't reach the bridge (page-origin CORS), so the
        // selection toolbar asks the worker to run the coach for it.
        const map = COACH_METHODS[message.method];
        if (!map) {
          sendResponse({ ok: false, error: `not allowed: ${message.method}` });
          break;
        }
        await ensureBrain();
        try {
          const result = await Promise.resolve(FA.coach[message.method](...map(message.payload || {})));
          sendResponse({ ok: true, result });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      case "FETCH_PDF": {
        // Fetch a PDF for the panel / our viewer. Drive files: the connected
        // Google account first (Drive API), then the browser's own Drive login
        // (cookies — the school account, usually). Anything else: cookie fetch.
        try {
          const buf = await fetchPdfBytes(message.url);
          sendResponse({ ok: true, base64: bytesToBase64(new Uint8Array(buf)) });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      case "NIGHTLY_SYNC":
        await syncNightlyAlarm();
        sendResponse({ ok: true });
        break;

      case "THREAD_APPEND": {
        // A highlight note / summary / answer from a page lands in the chat
        // of the assignment being worked, if a session is running.
        const s = await FA.store.getActiveSession();
        if (!s || !s.assignmentId || s.assignmentId === "free") {
          sendResponse({ ok: false, reason: "no session" });
          break;
        }
        const meta = await FA.store.getMeta();
        const thread = Array.isArray(meta[s.assignmentId]?.thread) ? meta[s.assignmentId].thread : [];
        thread.push({ role: "coach", text: String(message.text || "").slice(0, 3000), kind: message.kind || "page", at: Date.now() });
        await FA.store.patchAssignmentMeta(s.assignmentId, { thread: thread.slice(-40) });
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ error: `Unknown message: ${message.type}` });
    }
  })();
  return true; // async
});

/* ------------------------------------------------------------------ *
 * PDF fetching (Drive-aware)
 * ------------------------------------------------------------------ */
function driveIdOf(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "drive.google.com" && u.hostname !== "docs.google.com") return null;
    return u.searchParams.get("id") || (u.pathname.match(/\/file\/d\/([\w-]+)/) || [])[1] || null;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

async function fetchPdfBytes(url) {
  const id = driveIdOf(url);
  if (id) {
    // 1. Drive API with the connected account (works for anything shared with it).
    try {
      if (await FA.google.isConnected()) return await FA.google.fetchDriveFileBytes(id);
    } catch (e) {
      console.log("[Focus Agent] Drive API fetch failed, trying cookies:", e.message);
    }
    // 2. The browser's Drive session (needs drive.google.com host permission).
    let res = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, { credentials: "include" });
    let type = res.headers.get("content-type") || "";
    if (type.includes("text/html")) {
      // Large files get a "can't scan for viruses" page with a confirm token.
      const html = await res.text();
      const confirm = html.match(/confirm=([\w-]+)/)?.[1] || "t";
      const uuid = html.match(/name="uuid" value="([\w-]+)"/)?.[1];
      const u = new URL("https://drive.usercontent.google.com/download");
      u.searchParams.set("id", id);
      u.searchParams.set("export", "download");
      u.searchParams.set("confirm", confirm);
      if (uuid) u.searchParams.set("uuid", uuid);
      res = await fetch(u, { credentials: "include" });
      type = res.headers.get("content-type") || "";
      if (type.includes("text/html")) throw new Error("Drive wants you signed in — open the file in Drive once (or connect the Google account it's shared with)");
    }
    if (!res.ok) throw new Error(`Drive download ${res.status}`);
    return res.arrayBuffer();
  }
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (type.includes("text/html")) throw new Error("that link returned a web page, not a PDF");
  return res.arrayBuffer();
}

/* ------------------------------------------------------------------ *
 * Alarms: check-ins + commitment receipts
 * ------------------------------------------------------------------ */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CHECKIN_ALARM) {
    const session = await FA.store.getActiveSession();
    if (!session) {
      chrome.alarms.clear(CHECKIN_ALARM);
      return;
    }
    chrome.notifications.create(`fa-checkin-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Focus check-in",
      message: `Still on "${session.title}"?`,
      buttons: [{ title: "Locked in 🔒" }, { title: "Got distracted 😬" }],
      priority: 1,
    });
  }

  if (alarm.name === COMMITMENT_ALARM) {
    await fireDueCommitments();
  }

  if (alarm.name === DETECT_ALARM) {
    await detectCompletion();
  }

  if (alarm.name === NIGHTLY_ALARM) {
    await runNightlyPlan();
  }
});

/* ------------------------------------------------------------------ *
 * Nightly auto-plan (Ben's build, opt-in): at 4:30pm read the cached
 * assignments, build tonight's plan the way the time chips do, write the
 * blocks to Google Calendar when connected, and send ONE notification.
 * S04 builds this by hand in ChatGPT every night — this is the same plan,
 * unasked. Never ships on in the student build.
 * ------------------------------------------------------------------ */
const NIGHTLY_ALARM = "fa-nightly";

async function syncNightlyAlarm() {
  const settings = await FA.store.getSettings();
  const on = Boolean(settings.devMode && settings.nightlyPlan);
  const existing = await chrome.alarms.get(NIGHTLY_ALARM);
  if (!on) {
    if (existing) chrome.alarms.clear(NIGHTLY_ALARM);
    return;
  }
  if (existing) return;
  const when = new Date();
  when.setHours(16, 30, 0, 0);
  if (when <= new Date()) when.setDate(when.getDate() + 1);
  chrome.alarms.create(NIGHTLY_ALARM, { when: when.getTime(), periodInMinutes: 24 * 60 });
  console.log("[Focus Agent] nightly plan scheduled for", when.toString());
}
chrome.runtime.onStartup.addListener(syncNightlyAlarm);
chrome.runtime.onInstalled.addListener(syncNightlyAlarm);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) syncNightlyAlarm();
});

async function runNightlyPlan() {
  const settings = await FA.store.getSettings();
  if (!settings.devMode || !settings.nightlyPlan) return;
  const cache = await FA.store.getCachedAssignments();
  const items = cache?.items || [];
  if (!items.length) return;
  const [meta, sessions] = await Promise.all([FA.store.getMeta(), FA.store.getSessions()]);
  const ranked = FA.rankAssignments(items, meta, sessions);
  if (!ranked.length) return;
  await ensureBrain();
  const minutes = settings.nightlyMinutes || 120;
  const plan = await Promise.resolve(FA.coach.panicPlan(ranked, minutes));
  const work = plan.blocks.filter((b) => !b.isBreak);
  let calNote = "";
  try {
    if (await FA.google.isConnected()) {
      const evs = await FA.google.addPlanBlocks(work);
      calNote = ` ${evs.length} block${evs.length === 1 ? "" : "s"} on your calendar.`;
    }
  } catch (e) {
    calNote = ` (calendar: ${e.message})`;
  }
  await chrome.storage.local.set({ nightlyPlan: { at: Date.now(), plan, minutes } });
  chrome.notifications.create(`fa-nightly-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Tonight's plan",
    message: `${work.map((b) => `${b.start} ${b.title}`).slice(0, 3).join(" · ")}${work.length > 3 ? " · …" : ""}.${calNote}`,
    priority: 1,
  });
}

/* ------------------------------------------------------------------ *
 * The timer is the work: detect when the job is done
 *
 *   portal   the assignment vanished from the portal's PENDING list while a
 *            portal tab answered → the student marked it complete or
 *            submitted it. HIGH confidence → end the session, open "done".
 *   doc      the assignment's Google Doc hasn't changed in 8 min after at
 *            least one chunk → MEDIUM → the coach ASKS in the thread.
 *   tab      the assignment tab was closed → LOW → the coach ASKS once.
 *   steps    (panel) every checklist step checked → one-tap finish.
 *
 * Low/medium signals never end a session by themselves.
 * ------------------------------------------------------------------ */
let detectTick = 0;

async function appendThread(assignmentId, text, kind) {
  const meta = await FA.store.getMeta();
  const thread = Array.isArray(meta[assignmentId]?.thread) ? meta[assignmentId].thread : [];
  thread.push({ role: "coach", text: String(text).slice(0, 3000), kind, at: Date.now() });
  await FA.store.patchAssignmentMeta(assignmentId, { thread: thread.slice(-40) });
}

async function detectCompletion() {
  const session = await FA.store.getActiveSession();
  if (!session || !session.assignmentId || session.assignmentId === "free") {
    chrome.alarms.clear(DETECT_ALARM);
    return;
  }
  detectTick++;
  const elapsedMin = (Date.now() - session.startedAt) / 60000;

  // --- portal: pending list no longer contains this assignment ---
  const settings = await FA.store.getSettings();
  if (settings.dataSource === "auto" && detectTick % 2 === 0) {
    try {
      const tabs = await chrome.tabs.query({ url: PORTAL_MATCHES });
      for (const tab of tabs) {
        let res;
        try {
          res = await chrome.tabs.sendMessage(tab.id, { type: "GET_ASSIGNMENTS" });
        } catch {
          continue; // no content script in this tab
        }
        if (!Array.isArray(res?.assignments)) continue;
        await FA.store.cacheAssignments(res.assignments, "portal");
        const stillPending = res.assignments.some((a) => a.id === session.assignmentId);
        if (!stillPending) {
          await completeSession(session, "portal");
          return;
        }
        break; // one live tab is enough
      }
    } catch (e) {
      console.log("[Focus Agent] portal poll skipped:", e.message);
    }
  }

  // --- doc: unchanged for 8 min after the first chunk ---
  if (detectTick % 3 === 0 && elapsedMin >= (session.chunkMin || session.plannedMin || 10) && !session.askedDoc) {
    try {
      const meta = await FA.store.getMeta();
      const docUrl = meta[session.assignmentId]?.docUrl;
      if (docUrl && (await FA.google.isConnected())) {
        const d = await FA.google.readDoc(docUrl);
        const sig = `${d.revisionId || ""}:${d.text.length}`;
        const prev = session.docState;
        if (!prev || prev.sig !== sig) {
          await FA.store.updateActiveSession({ docState: { sig, at: Date.now() } });
        } else if (Date.now() - prev.at >= DOC_STALE_MS && d.text.trim().length > 200) {
          await FA.store.updateActiveSession({ askedDoc: true });
          await appendThread(session.assignmentId, "Your doc hasn't changed in 8 minutes — looks finished? Hit done ✓ if it's turned in, or tell me what's left.", "ask-done");
        }
      }
    } catch (e) {
      console.log("[Focus Agent] doc poll skipped:", e.message);
    }
  }
}

/** End the session on a detected completion and hand the panel a "done" to show. */
async function completeSession(session, reason) {
  chrome.alarms.clear(CHECKIN_ALARM);
  chrome.alarms.clear(DETECT_ALARM);
  const meta = await FA.store.getMeta();
  const steps = meta[session.assignmentId]?.steps || [];
  const record = await FA.store.endSession(reason, { stepsDone: steps.filter((s) => s.done).length, stepsTotal: steps.length });
  await FA.store.markDone(session.assignmentId);
  const cache = await FA.store.getCachedAssignments();
  const a = cache?.items?.find((x) => x.id === session.assignmentId) || { id: session.assignmentId, course: session.course, title: session.title };
  await FA.store.addQuestEvent(a, a.estMin || record.actualMin || 0);
  await chrome.storage.local.set({ pendingDone: { assignmentId: session.assignmentId, title: session.title, record, reason, at: Date.now() } });
  chrome.notifications.create(`fa-done-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: reason === "portal" ? "myPoly says it's done ✓" : "Done ✓",
    message: `"${session.title}" — ${record.actualMin} min this sitting. Session closed.`,
    priority: 1,
  });
}

// Tab activity during a session (paper-mode detection) + closing the assignment tab.
let lastActivityWrite = 0;
async function noteActivity(tabId) {
  if (Date.now() - lastActivityWrite < 10000) return;
  const session = await FA.store.getActiveSession();
  if (!session) return;
  lastActivityWrite = Date.now();
  await FA.store.updateActiveSession({ activityCount: (session.activityCount || 0) + 1 });
}
chrome.tabs.onActivated.addListener(({ tabId }) => noteActivity(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") noteActivity(tabId);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await FA.store.getActiveSession();
  if (!session || session.askedTab || !Array.isArray(session.tabs) || session.tabs[0] !== tabId) return;
  await FA.store.updateActiveSession({ askedTab: true });
  await appendThread(session.assignmentId, "You closed the assignment tab — done with it? Hit done ✓, or reopen it from the list.", "ask-done");
});

/** Commitment Receipts: "you told me 4pm" — the coach that remembers. */
async function fireDueCommitments() {
  const commitments = await FA.store.getCommitments();
  const now = Date.now();
  for (const c of commitments) {
    if (c.keptAt || c.missedAt || c.notifiedAt) continue;
    if (c.dueAt <= now) {
      c.notifiedAt = now; // mark before notifying so we never double-fire
      await chrome.storage.local.set({ commitments });
      chrome.notifications.create(`fa-commit-${c.id}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Receipts 🧾",
        message: `You told me: "${c.text}". That was the plan. Starting now?`,
        buttons: [{ title: "Starting now ✅" }, { title: "Not today ❌" }],
        priority: 2,
        requireInteraction: true,
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Notification button handling
 * ------------------------------------------------------------------ */
chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
  if (notifId.startsWith("fa-checkin-")) {
    const session = await FA.store.getActiveSession();
    if (!session) return;
    if (buttonIndex === 0) {
      await FA.store.updateActiveSession({ checkins: (session.checkins || 0) + 1 });
    } else {
      // Honest self-report counts as a distraction — the data is for the
      // student, not surveillance, so honesty is the whole point.
      await FA.store.addDistractionEvent("self-reported");
    }
  }

  if (notifId.startsWith("fa-commit-")) {
    const id = notifId.replace("fa-commit-", "");
    await FA.store.resolveCommitment(id, buttonIndex === 0);
  }

  chrome.notifications.clear(notifId);
});

/* ------------------------------------------------------------------ *
 * Distraction watcher: negotiate, don't block
 * ------------------------------------------------------------------ */
async function checkTabForDrift(tabId) {
  const session = await FA.store.getActiveSession();
  if (!session) return;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // tab is gone
  }
  if (!tab?.url) return;

  let host;
  try {
    host = new URL(tab.url).hostname;
  } catch {
    return;
  }
  if (!DISTRACTOR_PATTERNS.some((p) => p.test(host))) return;

  // Rate-limit the nudges so the coach isn't a nag.
  if (Date.now() - (session.lastNudgeAt || 0) < NUDGE_COOLDOWN_MS) return;

  // How much work is left, at this student's actual pace?
  const elapsedMin = Math.round((Date.now() - session.startedAt) / 60000);
  const remainingMin = Math.max(session.plannedMin - elapsedMin, 3);

  await FA.store.updateActiveSession({ lastNudgeAt: Date.now() });
  await FA.store.addDistractionEvent(host);

  chrome.notifications.create(`fa-nudge-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Coach here 👀",
    message: FA.coach.negotiationLine(session, remainingMin, host),
    priority: 2,
  });
}

chrome.tabs.onActivated.addListener(({ tabId }) => checkTabForDrift(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) checkTabForDrift(tabId);
});

/* ------------------------------------------------------------------ *
 * Open the side panel when the toolbar icon is clicked (popup still
 * works; this makes the panel one click away too).
 * ------------------------------------------------------------------ */
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {});
