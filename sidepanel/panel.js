/**
 * sidepanel/panel.js - The coach's one screen.
 *
 * Three states + ▸more:
 *   list → every pending assignment; one primary action: ▶ Smart Start
 *   work → the assignment you're on: elapsed clock, editable checklist
 *          (the breakdown), and the coach chat scoped to THIS assignment
 *   done → what just happened, what's next
 *   more → classes, stats, XP, commitments, general chat, settings
 *
 * All data flows through FA.* libs; the AI brain is FA.coach (MockCoach
 * rules, or ClaudeCoach through the local bridge — zero changes here).
 */

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
let assignments = [];   // normalized, from the portal tab or the cache
let ranked = [];        // assignments + estMin + urgency, sorted
let sourceNotice = "";  // why we're NOT showing live portal data ("" when live)
let snapshot = null;    // full Student Snapshot (classes, grades, schedule)
let settings = {};      // cached FA.store.getSettings()
let timerInterval = null;
let timeBudget = 0;     // minutes chosen on the "tonight I have" row (0 = all)
let view = "list";

/** The assignment being worked in State B. */
let current = null;     // { assignment, steps: [], thread: [], awaitingDraft: false }

const $ = (id) => document.getElementById(id);

/** Escape brain-generated text before any innerHTML use. */
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DISTRACTOR_PATTERNS = [
  /youtube\.com/, /tiktok\.com/, /instagram\.com/, /twitter\.com/, /x\.com/,
  /reddit\.com/, /netflix\.com/, /twitch\.tv/, /discord\.com/, /pinterest\.com/,
];

const PORTAL_URL_PATTERNS = [
  "https://*.myschoolapp.com/*",
  "https://*.blackbaud.com/*",
  "https://*.instructure.com/*",
  "https://classroom.google.com/*",
];
// Portals the student connected by hand (⚙ → connect my school) join the list.
chrome.storage.local.get("customPortals").then(({ customPortals = {} }) => {
  for (const o of Object.keys(customPortals)) PORTAL_URL_PATTERNS.push(o + "/*");
});

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */
function showView(name) {
  view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".dock .tab").forEach((b) => b.classList.toggle("active", b.dataset.view === name || (name === "work" && b.dataset.view === "list") || (name === "done" && b.dataset.view === "list")));
  if (name === "chat") setTimeout(() => $("chat-input")?.focus(), 50);
  $("more-btn").textContent = name === "more" ? "◂" : "⚙";
  $("more-btn").title = name === "more" ? "Back" : "Settings";
  window.scrollTo({ top: 0 });
}

/** The dock: today (list, or the running session), you, classes. */
document.querySelectorAll(".dock .tab").forEach((b) =>
  b.addEventListener("click", async () => {
    if (b.dataset.view === "list") {
      const s = await FA.store.getActiveSession();
      showView(s && current ? "work" : "list");
    } else showView(b.dataset.view);
  })
);

/**
 * 🖍 in the header: make the page you're on highlightable right now.
 * activeTab grants us this one tab on the click, so it works on any site
 * without the permission prompt. PDFs in Chrome's built-in viewer can't be
 * injected into — they reopen in our pdf.js viewer instead.
 */
$("highlight-btn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return;
  const btn = $("highlight-btn");
  const flash = (txt) => {
    btn.textContent = txt;
    setTimeout(() => (btn.textContent = "🖍"), 2200);
  };
  if (/^chrome:|^chrome-extension:\/\/(?!.*viewer\/pdfjs)/.test(tab.url) && !tab.url.includes("/viewer/pdfjs/")) return flash("✕");
  // Google Docs draws on a canvas (no text selection), and images have no
  // text at all — those go the screenshot route instead of a dead end.
  if (/docs\.google\.com\/(document|presentation|spreadsheets)/.test(tab.url) || /\.(png|jpe?g|gif|webp|bmp|svg)($|[?#])/i.test(tab.url)) {
    flash("📸");
    return snapScreen();
  }
  const pdf = pdfSourceFor(tab.url);
  if (pdf && !tab.url.includes("/viewer/pdfjs/")) {
    // Ask for the PDF host now (still inside the click); the viewer has its
    // own "allow" button as a fallback if this can't prompt.
    try {
      const origins = isDriveUrl(pdf) ? ["https://drive.google.com/*", "https://drive.usercontent.google.com/*"] : [new URL(pdf).origin + "/*"];
      await chrome.permissions.request({ origins });
    } catch {
      /* viewer banner handles it */
    }
    await chrome.tabs.update(tab.id, { url: viewerUrlFor(pdf) });
    return flash("↻");
  }
  if (tab.url.startsWith("file:") || /\.pdf($|[?#])/i.test(new URL(tab.url).pathname)) return flash("✕");
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["annotate/selection-toolbar.js"] });
    // Remember the site so it's on next time too (may prompt; fine if declined).
    try {
      const o = new URL(tab.url);
      if (/^https?:$/.test(o.protocol)) chrome.permissions.request({ origins: [`${o.origin}/*`] }).catch(() => {});
    } catch {
      /* not an http(s) tab */
    }
    flash("✓");
  } catch (e) {
    console.warn("[Focus Agent] can't highlight here, trying a screenshot:", e.message);
    flash("📸");
    return snapScreen();
  }
});
$("snap-btn").addEventListener("click", () => snapScreen());

/* ------------------------------------------------------------------ *
 * Data loading
 * ------------------------------------------------------------------ */

/** Load assignments: a live portal tab first, else the last cached fetch. */
async function loadAssignments(retried = false) {
  settings = await FA.store.getSettings();
  $("mode-select").value = settings.mode || "tutor";
  $("dev-toggle").checked = Boolean(settings.devMode);
  $("bridge-url").value = settings.bridgeUrl || "";
  $("bridge-token").value = settings.bridgeToken || "";
  $("nightly-toggle").checked = Boolean(settings.nightlyPlan);
  $("autopilot-toggle").checked = Boolean(settings.autopilot);
  $("auto-done-toggle").checked = Boolean(settings.autoDone);
  document.body.classList.toggle("dev", Boolean(settings.devMode));

  sourceNotice = "";

  // Find an open portal tab and ask its content script.
  const tabs = await chrome.tabs.query({ url: PORTAL_URL_PATTERNS });

  // Every step is recorded so a failure explains itself in the headline
  // instead of silently showing nothing.
  const diag = [`${tabs.length} portal tab${tabs.length === 1 ? "" : "s"} open`];
  let disconnected = 0;

  for (const tab of tabs) {
    const label = new URL(tab.url).hostname;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_ASSIGNMENTS" });
      if (res?.error) {
        diag.push(`${label}: ${res.error}`);
      } else if (res?.assignments?.length) {
        assignments = res.assignments;
        console.log(`[Focus Agent] panel: ${assignments.length} assignments from ${label}`);
        try {
          const snapRes = await chrome.tabs.sendMessage(tab.id, { type: "GET_SNAPSHOT" });
          snapshot = snapRes?.snapshot || (await FA.loadSnapshot());
        } catch {
          snapshot = await FA.loadSnapshot();
        }
        return;
      } else {
        diag.push(`${label}: portal returned 0 pending assignments`);
      }
    } catch (e) {
      // Usually "Receiving end does not exist": the tab was open before the
      // extension loaded/reloaded, so it has no content script.
      disconnected++;
      diag.push(`${label}: not connected`);
    }
  }

  if (disconnected && !retried) {
    try {
      const r = await chrome.runtime.sendMessage({ type: "REINJECT" });
      if (r?.tabs) {
        await new Promise((res) => setTimeout(res, 1500));
        return loadAssignments(true);
      }
    } catch {
      /* worker asleep — fall through */
    }
  }

  snapshot = await FA.loadSnapshot();
  const cache = await FA.store.getCachedAssignments();
  const why = disconnected
    ? `${diag[0]}, ${disconnected} not connected — refresh a portal tab, then hit ↻`
    : diag.slice(0, 3).join("; ");
  console.warn("[Focus Agent] panel: no live portal data.", why);
  if (cache?.items?.length) {
    assignments = cache.items;
    sourceNotice = `⚠️ Cached assignments from ${new Date(cache.fetchedAt).toLocaleTimeString()} — ${why}. Refresh your portal tab, then hit ↻.`;
  } else {
    assignments = [];
    sourceNotice = `Open your school portal in a tab (myPoly, Canvas, Classroom — or ⚙ → connect my school), then hit ↻. ${why}.`;
  }
}

/** Manual + automatic re-read of the portal (↻ button, portal tab loads). */
async function reloadFromPortal() {
  $("refresh-btn").classList.add("spinning");
  try {
    await loadAssignments();
    await refreshAll();
  } finally {
    $("refresh-btn").classList.remove("spinning");
  }
}

// Coalesce bursts of tab events (SPAs fire several "complete"s per load).
let portalRefreshTimer = null;
function schedulePortalRefresh() {
  clearTimeout(portalRefreshTimer);
  portalRefreshTimer = setTimeout(reloadFromPortal, 1500);
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  const custom = PORTAL_URL_PATTERNS.some((p) => p.startsWith("https://") && !p.includes("*.") && tab.url.startsWith(p.slice(0, -2)));
  if (custom || /myschoolapp\.com|blackbaud\.com|instructure\.com|classroom\.google\.com/.test(tab.url)) {
    schedulePortalRefresh();
  }
});

async function refreshAll() {
  const [meta, sessions, questEvents, commitments] = await Promise.all([
    FA.store.trackSeen(assignments),
    FA.store.getSessions(),
    FA.store.getQuestEvents(),
    FA.store.getCommitments(),
  ]);

  ranked = FA.rankAssignments(assignments, meta, sessions);

  renderStreak(sessions);
  renderForecast(meta, sessions);
  renderList(meta);
  renderAvoidance(meta, sessions);
  renderStats(sessions, commitments);
  renderLevel(sessions, questEvents);
  renderCommitments(commitments);
  renderClasses();
  await renderResumeBanner();
}

/* ------------------------------------------------------------------ *
 * STATE A — the list
 * ------------------------------------------------------------------ */
function renderStreak(sessions) {
  $("streak-badge").textContent = `🔥 ${FA.computeStreak(sessions)}`;
}

function renderForecast(meta, sessions) {
  const { days, headline } = FA.buildForecast(assignments, meta, sessions);
  const strip = $("forecast-strip");
  strip.innerHTML = "";
  for (const d of days) {
    const el = document.createElement("div");
    el.className = "forecast-day" + (d.label === "STORM" ? " storm" : "");
    el.title = d.due.length
      ? `${d.due.length} due (~${d.loadMin} min): ${d.due.map((a) => a.title).join(", ")}`
      : "Nothing due";
    el.innerHTML = `<div class="icon">${d.icon}</div><div class="name">${d.name}</div>`;
    strip.appendChild(el);
  }
  // The source notice wins over the forecast line.
  $("forecast-headline").textContent = sourceNotice || headline;
}

function dueLabel(a) {
  if (!a.dueDate) return "no due date";
  const h = FA.hoursUntil(a.dueDate);
  if (h < 0) return "OVERDUE";
  if (h < 24) return "due today/tomorrow";
  return `due ${new Date(a.dueDate).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
}

function renderList(meta = {}) {
  // Instant pick from the rules, upgraded in place by the real brain.
  const box = $("coach-pick");
  box.classList.remove("hidden");
  const showPick = ({ assignment, reason }, fromClaude) => {
    const prefix = fromClaude ? "🧠 " : "";
    $("coach-pick-text").textContent = assignment
      ? `${prefix}"${assignment.title}" — ${reason}`
      : prefix + reason;
  };
  showPick(new FA.MockCoach().pick(ranked), false);
  if (FA.coachBrain === "claude") {
    Promise.resolve(FA.coach.pick(ranked)).then((p) => showPick(p, true)).catch(() => {});
  }

  const list = $("today-list");
  list.innerHTML = "";
  if (!ranked.length) {
    list.innerHTML = assignments.length
      ? '<div class="empty-note">Nothing pending. 🏖️</div>'
      : '<div class="empty-note">No assignments yet.<br><span class="small">Open your school portal in a tab and hit ↻ — or ⚙ → connect my school.</span></div>';
    return;
  }

  for (const a of ranked) {
    const h = FA.hoursUntil(a.dueDate);
    const card = document.createElement("div");
    card.className = "card" + (h < 0 ? " overdue" : h < 30 ? " due-soon" : "");
    const steps = meta?.[a.id]?.steps || [];
    const done = steps.filter((s) => s.done).length;
    card.innerHTML = `
      <div class="card-row">
        <div class="card-main">
          <div class="card-title"></div>
          <div class="card-meta"></div>
        </div>
        <div class="card-side">
          ${steps.length ? `<span class="progress-pill" title="checklist progress">${done}/${steps.length}</span>` : ""}
          <button class="start" title="Open what you need, park what you don't, start the clock">▶ Smart Start</button>
          <button class="done-mini" title="Already finished this">✓</button>
        </div>
      </div>`;
    card.querySelector(".card-title").textContent = a.title;
    card.querySelector(".card-meta").textContent =
      `${a.course} · ${dueLabel(a)} · ~${a.estMin} min` + (a.points ? ` · ${a.points} pts` : "");
    card.querySelector(".start").addEventListener("click", () => smartStart(a));
    card.querySelector(".done-mini").addEventListener("click", async () => {
      await FA.store.markDone(a.id);
      await FA.store.addQuestEvent(a, a.estMin);
      await refreshAll();
    });
    list.appendChild(card);
  }
}

/** "tonight I have N minutes" → the list becomes tonight's triage. */
async function setTimeBudget(min) {
  timeBudget = min;
  document.querySelectorAll(".time-chip").forEach((c) => c.classList.toggle("active", Number(c.dataset.min) === min));
  const wrap = $("plan-inline");
  if (!min) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");
  if (FA.coachBrain === "claude") {
    wrap.innerHTML = '<div class="pep">🧠 Triaging your night… (~15s)</div>';
  }
  const { blocks, sacrifices, pep } = await Promise.resolve(FA.coach.panicPlan(ranked, min));
  if (timeBudget !== min) return; // user changed their mind mid-call
  wrap.innerHTML = "";

  const pepEl = document.createElement("div");
  pepEl.className = "pep";
  pepEl.textContent = pep;
  wrap.appendChild(pepEl);

  for (const b of blocks) {
    const el = document.createElement("div");
    el.className = "plan-block" + (b.isBreak ? " break-block" : "");
    if (b.isBreak) {
      el.textContent = `☕ ${b.title} (${b.minutes} min)`;
    } else {
      el.innerHTML = `<span class="plan-time"></span><span class="plan-body"><span class="plan-title"></span><br><span class="plan-note"></span></span><button class="start mini">▶</button>`;
      el.querySelector(".plan-time").textContent = `${b.start}–${b.end}`;
      el.querySelector(".plan-title").textContent = `${b.title} (${b.course})`;
      el.querySelector(".plan-note").textContent = b.note;
      const a = ranked.find((x) => x.id === b.assignmentId);
      el.querySelector(".start").addEventListener("click", () => a && smartStart(a, b.minutes));
    }
    wrap.appendChild(el);
  }
  for (const s of sacrifices) {
    const el = document.createElement("div");
    el.className = "sacrifice";
    el.innerHTML = `<b>Sacrifice:</b> <span class="s-title"></span> — <span class="s-why"></span>`;
    el.querySelector(".s-title").textContent = `${s.title} (${s.course})`;
    el.querySelector(".s-why").textContent = s.why;
    wrap.appendChild(el);
  }
}

/* Avoidance detection — a friend noticing, never a guilt trip. */
function renderAvoidance(meta, sessions) {
  const card = $("avoid-card");
  const avoided = FA.findAvoided(ranked, meta, sessions);
  if (!avoided.length) {
    card.classList.add("hidden");
    return;
  }
  const { assignment, daysVisible, overdue } = avoided[0];
  card.classList.remove("hidden");
  $("avoid-text").textContent = overdue
    ? `"${assignment.title}" slipped past its due date without a single session. That usually means it feels too big — not that you don't care. Smallest possible start?`
    : `"${assignment.title}" has been sitting there ${daysVisible} day${daysVisible > 1 ? "s" : ""} and you haven't touched it. Usually that means it feels too big. Let's shrink it.`;
  $("avoid-micro").onclick = () => smartStart(assignment, 2);
}

/** When a session is running and you're on the list, one tap gets you back. */
async function renderResumeBanner() {
  const s = await FA.store.getActiveSession();
  const b = $("resume-banner");
  if (!s) {
    b.classList.add("hidden");
    return;
  }
  const min = Math.floor((Date.now() - s.startedAt) / 60000);
  b.textContent = `▶ back to "${s.title}" · ${min} min in`;
  b.classList.remove("hidden");
  b.onclick = async () => {
    const a = ranked.find((x) => x.id === s.assignmentId) || assignments.find((x) => x.id === s.assignmentId);
    await enterWork(a || { id: s.assignmentId, title: s.title, course: s.course, estMin: s.plannedMin });
  };
}

/* ------------------------------------------------------------------ *
 * Smart Start: park what isn't needed, open what is, start the clock,
 * and land in the work view with the coach already talking.
 * ------------------------------------------------------------------ */
async function buildSetupResources(a) {
  return {
    links: a.links || [],
    topics: snapshot?.topics?.[a.sectionId] || [],
    googleConnected: await FA.google.isConnected().catch(() => false),
    description: a.description || "",
  };
}

/** Execute a setup plan: open the chosen tabs, create the doc. Returns what happened. */
async function executeSetupPlan(assignment, plan, resources) {
  const opened = [];
  for (const o of plan.opens || []) {
    const target = o.kind === "link" ? resources.links[o.i] : resources.topics[o.i];
    if (!target?.url) continue;
    await rememberTab(await openTab(target.url, false));
    opened.push({ label: (o.kind === "topic" ? "📖 " : "🔗 ") + (target.name || target.text || target.url), why: o.why });
  }
  if (plan.doc && resources.googleConnected) {
    try {
      const meta = await FA.store.getMeta();
      let docUrl = meta?.[assignment.id]?.docUrl || null;
      if (!docUrl) {
        const steps = (current?.steps || []).map((s) => s.text);
        const { id, url } = await FA.google.createOutlineDoc(assignment.title, assignment.course, steps.length ? steps : new FA.MockCoach().breakdown(assignment));
        docUrl = url;
        await FA.store.patchAssignmentMeta(assignment.id, { docUrl, docId: id });
      }
      await chrome.tabs.create({ url: docUrl, active: false });
      opened.push({ label: "📄 your doc, outline ready", why: "" });
    } catch (e) {
      console.warn("[Focus Agent] setup doc failed (non-fatal):", e.message);
    }
  }
  return opened;
}

/** The setup plan as the coach's opening message. */
function setupMessage(plan, opened) {
  const lines = [];
  if (opened.length) lines.push(`opened: ${opened.map((o) => o.label).join(" · ")}`);
  if (plan.gather?.length) lines.push(`have ready: ${plan.gather.join(" · ")}`);
  lines.push(`🎯 your part: ${plan.focus}`);
  if (plan.firstMove) lines.push(`▶ first move: ${plan.firstMove}`);
  return lines.join("\n");
}

/**
 * If this URL is a PDF we can show in our own viewer, return the direct file
 * URL to load; else null. Google Drive "file" links (the usual way teachers
 * share PDFs) map to Drive's download endpoint, which sends the file itself.
 */
function pdfSourceFor(url) {
  try {
    const u = new URL(url);
    if (u.href.startsWith(chrome.runtime.getURL(""))) return null;
    const drive = u.hostname === "drive.google.com" && u.pathname.match(/\/file\/d\/([\w-]+)/);
    if (drive) return `https://drive.google.com/uc?export=download&id=${drive[1]}`;
    if (/\.pdf($|[?#])/i.test(u.pathname + u.search) || u.searchParams.get("format") === "pdf") return u.href;
  } catch {
    /* not a URL */
  }
  return null;
}
// Drive files can't be streamed by pdf.js (login, confirm pages) → the viewer
// asks the worker to fetch them (fa_file). Plain URLs stream directly (file).
const isDriveUrl = (u) => /^https:\/\/(drive|docs)\.google\.com\//.test(u);
const viewerUrlFor = (fileUrl) => chrome.runtime.getURL("viewer/pdfjs/web/viewer.html") + (isDriveUrl(fileUrl) ? "?fa_file=" : "?file=") + encodeURIComponent(fileUrl);

/** Open a URL in a tab; PDFs go through our pdf.js viewer so highlighting works. */
async function openTab(url, active) {
  const pdf = pdfSourceFor(url);
  return chrome.tabs.create({ url: pdf ? viewerUrlFor(pdf) : url, active });
}

/**
 * Ask for host permission on the sites this assignment needs, so the
 * highlight toolbar (and the PDF viewer's fetch) work there. Must run
 * synchronously inside the click — Chrome only grants inside a user gesture.
 */
function requestOriginsFor(assignment) {
  const origins = new Set();
  const add = (u) => {
    try {
      const o = new URL(u);
      if (/^https?:$/.test(o.protocol)) origins.add(`${o.origin}/*`);
    } catch {
      /* skip */
    }
  };
  add(assignment.url);
  for (const l of assignment.links || []) add(l.url);
  for (const t of snapshot?.topics?.[assignment.sectionId] || []) add(t.url);
  if (!origins.size || !chrome.permissions?.request) return Promise.resolve(false);
  return chrome.permissions.request({ origins: [...origins] }).catch(() => false);
}

async function smartStart(assignment, minOverride) {
  // 0. Permission for this assignment's sites (inside the click gesture).
  const permission = requestOriginsFor(assignment);

  // 1. Park distracting tabs into a separate minimized window (reversible).
  try {
    const allTabs = await chrome.tabs.query({ currentWindow: true });
    const distractors = allTabs.filter((t) => {
      try {
        return DISTRACTOR_PATTERNS.some((p) => p.test(new URL(t.url).hostname)) && !t.active;
      } catch {
        return false;
      }
    });
    if (distractors.length) {
      const parkingLot = await chrome.windows.create({ tabId: distractors[0].id, state: "minimized", focused: false });
      if (distractors.length > 1) {
        await chrome.tabs.move(distractors.slice(1).map((t) => t.id), { windowId: parkingLot.id, index: -1 });
      }
    }
  } catch (e) {
    console.warn("[Focus Agent] Tab parking failed (non-fatal):", e.message);
  }

  // The general "ask the coach anything" chat is about the week; a new
  // assignment starts it fresh so nothing bleeds between assignments.
  chatHistory = [];
  await chrome.storage.local.set({ chatHistory: [] });
  renderChatMessages();

  // 2. Start the clock and land in the work view immediately — everything
  //    else streams in. Waiting on tabs or the brain is how starts die.
  const active = await FA.store.getActiveSession();
  if (active && active.assignmentId !== assignment.id) {
    await FA.store.endSession("stop");
    chrome.runtime.sendMessage({ type: "SESSION_ENDED" }).catch(() => {});
  }
  if (!active || active.assignmentId !== assignment.id) {
    await startSession(assignment, minOverride);
  }
  await enterWork(assignment);

  // 3. Smart Setup: read the instructions, open what they call for.
  const resources = await buildSetupResources(assignment);
  const meta = await FA.store.getMeta();
  const autopilot = Boolean(settings.devMode && settings.autopilot);
  let plan = meta?.[assignment.id]?.setupPlan || new FA.MockCoach().setup(assignment, resources);
  // What the plan SAYS to open, it opens. Autopilot opens everything relevant
  // and always wants the doc when written work is involved.
  plan = FA.resolveOpens(plan, resources, { aggressive: autopilot });
  if (autopilot && ["essay", "project", "homework", "other", "lab"].includes(assignment.type)) plan = { ...plan, doc: Boolean(resources.googleConnected) };

  await permission; // resolved or denied — either way we go on
  if (assignment.url) await rememberTab(await openTab(assignment.url, true));
  let opened = [];
  try {
    opened = await executeSetupPlan(assignment, plan, resources);
  } catch (e) {
    console.warn("[Focus Agent] setup execution failed (non-fatal):", e.message);
  }

  // 3b. The coach files what it opened, so the reading is in memory for this
  //     assignment no matter which tab is active later.
  try {
    const meta2 = await FA.store.getMeta();
    if (meta2?.[assignment.id]?.docUrl) await attachUrl(meta2[assignment.id].docUrl, "your doc", { silent: true });
    for (const o of plan.opens || []) {
      const target = o.kind === "link" ? resources.links[o.i] : resources.topics[o.i];
      if (target?.url) await attachUrl(target.url, target.name || target.text || "", { silent: true });
    }
  } catch (e) {
    console.warn("[Focus Agent] auto-attach skipped:", e.message);
  }

  // 4. The coach speaks first: the setup summary, then a question if it
  //    isn't sure what the assignment wants.
  await pushCoach(setupMessage(plan, opened), { kind: "setup" });
  if (!settings.hintedHighlight) {
    await FA.store.setSettings({ hintedHighlight: true });
    settings.hintedHighlight = true;
    await pushCoach("Tip: on the pages I opened, select any text → 🖍 annotate · ≡ summarize · ? ask pop up above it. Other page? Tap 🖍 in the header first. (Google Docs can't be highlighted — use check my draft.)", { kind: "nudge" });
  }
  if ((plan.confidence ?? 1) < 0.6 && plan.missing?.length && !autopilot) {
    await pushCoach(`Before we go — ${plan.missing[0]}?`, { kind: "question" });
  }

  // 4b. Autopilot (Ben's build): no questions — do the work, then report.
  if (autopilot) runAutopilot(assignment).catch((e) => console.warn("[Focus Agent] autopilot:", e.message));

  // 5. Brain upgrade in the background: better plan + suggested extras as
  //    click-to-open lines, never surprise tabs mid-session.
  if (FA.coachBrain === "claude" && !plan.fromClaude) {
    Promise.resolve(FA.coach.setup(assignment, resources))
      .then(async (brainPlan0) => {
        let brainPlan = brainPlan0;
        if (!brainPlan.fromClaude || current?.assignment.id !== assignment.id) return;
        brainPlan = FA.resolveOpens(brainPlan, resources, { aggressive: autopilot });
        await FA.store.patchAssignmentMeta(assignment.id, { setupPlan: brainPlan });
        const alreadyOpened = new Set((plan.opens || []).map((o) => `${o.kind}:${o.i}`));
        const extraOpens = (brainPlan.opens || []).filter((o) => !alreadyOpened.has(`${o.kind}:${o.i}`));
        // Autopilot: open what the brain added too, instead of offering buttons.
        if (autopilot) {
          for (const o of extraOpens) {
            const target = o.kind === "link" ? resources.links[o.i] : resources.topics[o.i];
            if (target?.url) await rememberTab(await openTab(target.url, false));
          }
        }
        const extras = (autopilot ? [] : extraOpens)
          .map((o) => (o.kind === "link" ? resources.links[o.i] : resources.topics[o.i]))
          .filter((t) => t?.url);
        let text = "🧠 " + setupMessage(brainPlan, opened);
        if (extras.length) text += `\nmight help: ${extras.map((t) => t.name || t.text || t.url).join(" · ")}`;
        await pushCoach(text, { kind: "setup", links: extras.map((t) => t.url) });
        if ((brainPlan.confidence ?? 1) < 0.6 && brainPlan.missing?.length) {
          await pushCoach(`Quick check — ${brainPlan.missing[0]}?`, { kind: "question" });
        }
      })
      .catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * Sessions (the clock)
 * ------------------------------------------------------------------ */
async function startSession(assignment, minOverride) {
  // Ramp: this sitting's length comes from the student's own history (see
  // FA.proposeChunk), never from the size of the assignment. A minOverride
  // (2-min micro-start, a triage block) wins when given.
  const sessions = await FA.store.getSessions();
  const proposal = FA.proposeChunk(sessions, assignment);
  const plannedMin = minOverride ?? proposal.minutes;
  await FA.store.startSession(assignment, plannedMin, { chunkWhy: minOverride ? "" : proposal.why });
  chrome.runtime.sendMessage({ type: "SESSION_STARTED", checkinMin: plannedMin }).catch(() => {});
}

/** Track the tabs Smart Start opened so the worker can notice them closing. */
async function rememberTab(tab) {
  if (!tab?.id) return;
  const s = await FA.store.getActiveSession();
  if (!s) return;
  await FA.store.updateActiveSession({ tabs: [...(s.tabs || []), tab.id] });
}

/* ------------------------------------------------------------------ *
 * STATE B — the work view
 * ------------------------------------------------------------------ */
async function enterWork(assignment) {
  const meta = await FA.store.getMeta();
  const m = meta?.[assignment.id] || {};
  current = {
    assignment,
    steps: Array.isArray(m.steps) ? m.steps : [],
    thread: Array.isArray(m.thread) ? m.thread : [],
    files: Array.isArray(m.files) ? m.files : [],
    tests: Array.isArray(m.tests) ? m.tests : [],
    awaitingDraft: false,
  };
  renderFiles();

  document.body.classList.toggle("studying", assignment.type === "test");
  $("work-title").textContent = assignment.title;
  $("work-meta").textContent = [assignment.course, dueLabel(assignment), assignment.estMin ? `~${assignment.estMin} min` : ""].filter(Boolean).join(" · ");
  renderSteps();
  renderThread();
  showView("work");
  await restoreClock();

  // No checklist yet → build one (rules instantly, brain upgrades in place).
  if (!current.steps.length) {
    current.steps = new FA.MockCoach().breakdownSteps(assignment);
    renderSteps();
    await saveSteps();
    if (FA.coachBrain === "claude") {
      Promise.resolve(FA.coach.breakdownSteps(assignment))
        .then(async (steps) => {
          // Only replace an untouched rules checklist.
          if (current?.assignment.id !== assignment.id || current.steps.some((s) => s.done || s.source === "user")) return;
          current.steps = steps;
          renderSteps();
          await saveSteps();
        })
        .catch(() => {});
    }
  }
}

const RING_C = 603.19; // 2π·96, the ring circle's circumference

async function restoreClock() {
  clearInterval(timerInterval);
  const session = await FA.store.getActiveSession();
  const moodRow = $("mood-row");
  const ring = $("ring-fg");
  const startBtn = $("ring-start");
  if (!session) {
    // No clock → the ring is the start button, pre-set to the Ramp proposal.
    const sessions = await FA.store.getSessions();
    const proposal = current ? FA.proposeChunk(sessions, current.assignment) : { minutes: 15 };
    $("work-elapsed").textContent = "—";
    $("work-elapsed").classList.add("dim");
    $("work-chunk").textContent = "no clock running";
    startBtn.textContent = `▶ start ${proposal.minutes} min`;
    startBtn.classList.remove("hidden");
    ring.style.strokeDashoffset = RING_C;
    ring.classList.remove("overtime", "idle");
    moodRow.classList.add("hidden");
    stopTimeUpCountdown();
    return;
  }
  startBtn.classList.add("hidden");
  $("work-elapsed").classList.remove("dim");
  // Reopened the panel mid "keep going?" window → resume the countdown (or stop now if it already ran out).
  if (session.timeUpAt) startTimeUpCountdown(session);
  else stopTimeUpCountdown();
  if (!session.mood && !session.moodSkipped) {
    moodRow.classList.remove("hidden");
    $("mood-response").classList.add("hidden");
  } else {
    moodRow.classList.add("hidden");
  }
  renderChunkChips(session);
  let checkpointFired = false;
  const tick = () => {
    const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
    const mm = Math.floor(elapsed / 60);
    const ss = String(elapsed % 60).padStart(2, "0");
    $("work-elapsed").textContent = `${mm}:${ss}`;
    const chunk = session.plannedMin * 60;
    const pct = Math.min((elapsed / chunk) * 100, 100);
    ring.style.strokeDashoffset = (RING_C * (1 - pct / 100)).toFixed(1);
    ring.classList.toggle("overtime", elapsed > chunk && !session.idleAskAt);
    ring.classList.toggle("idle", Boolean(session.idleAskAt));
    const stepsDone = current?.steps.filter((s) => s.done).length || 0;
    const stepsTotal = current?.steps.length || 0;
    const stepTag = stepsTotal ? ` · step ${Math.min(stepsDone + 1, stepsTotal)}/${stepsTotal}` : "";
    $("work-chunk").textContent = session.idleAskAt
      ? "still there? tap anything"
      : session.mode === "paper"
        ? "paper mode — still stops at the planned end" + stepTag
        : elapsed <= chunk
          ? `${Math.ceil((chunk - elapsed) / 60)} min left${stepTag}`
          : `time ⏰ — keep going or stop?${stepTag}`;
    // Planned end → the one "keep going?" ask, then a hard stop (see onTimeUp).
    if (elapsed >= chunk && !checkpointFired && !session.timeUpAt) {
      checkpointFired = true;
      onTimeUp(session);
    }
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

/** Ramp chips: 5 · 10 · 15 · 20 · 25, the proposal pre-selected, tap to change. */
function renderChunkChips(session) {
  const wrap = $("chunk-chips");
  wrap.innerHTML = "";
  for (const m of [5, 10, 15, 20, 25]) {
    const b = document.createElement("button");
    b.textContent = `${m}`;
    b.title = `${m}-minute sitting`;
    b.classList.toggle("active", m === session.plannedMin);
    b.addEventListener("click", async () => {
      await FA.store.updateActiveSession({ plannedMin: m, checkpointFor: null, timeUpAt: 0 });
      stopTimeUpCountdown();
      chrome.runtime.sendMessage({ type: "SESSION_STARTED", checkinMin: m }).catch(() => {});
      await restoreClock();
    });
    wrap.appendChild(b);
  }
  $("chunk-why").textContent = session.chunkWhy || "";
}

/* ------------------------------------------------------------------ *
 * Time's up — the hard stop (panel side).
 *
 * 25 minutes means 25. At the planned end: chime, one card asking "keep
 * going?" with +5 / +10 / done / stop, and TIME_UP_GRACE_MS to answer. No
 * answer → the clock stops AT the planned end, so the log never says
 * 25-plus-whatever. The worker mirrors this with a notification + alarm for
 * when the panel is closed; whoever gets there first sets session.timeUpAt
 * and plays the chime, so it only sounds once.
 * ------------------------------------------------------------------ */
const TIME_UP_GRACE_MS = 45 * 1000;
let timeUpTimer = null;
const plannedEnd = (session) => session.startedAt + (session.plannedMin || 0) * 60000;

/** Three rising tones via WebAudio — no asset to ship. */
function playChime() {
  try {
    const ctx = new AudioContext();
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.65);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch {
    /* no audio here — the worker's chime covers it */
  }
}

async function onTimeUp(session) {
  const fresh = (await FA.store.getActiveSession()) || session;
  if (!fresh.timeUpAt) {
    await FA.store.updateActiveSession({ timeUpAt: Date.now() });
    playChime();
  }
  // First boundary also decides paper mode (no doc, no tab activity → the work is off-screen).
  if (fresh.mode !== "paper" && !fresh.paperChecked) {
    const meta = await FA.store.getMeta();
    const hasDoc = Boolean(meta?.[fresh.assignmentId]?.docUrl);
    await FA.store.updateActiveSession({ paperChecked: true });
    if (!hasDoc && (fresh.activityCount || 0) === 0) await FA.store.updateActiveSession({ mode: "paper" });
  }
  const cur = current?.steps.find((s) => !s.done);
  const done = current?.steps.filter((s) => s.done).length || 0;
  const total = current?.steps.length || 0;
  const head = `⏰ ${fresh.plannedMin} min — that's the sitting.${total ? ` ${done}/${total} steps.` : ""}`;
  const body = cur ? `Keep going on “${cur.text}”, or stop here?` : "Everything on the list is checked — done?";
  await pushCoach(`${head} ${body}`, {
    kind: "timeup",
    actions: [
      { label: "+5 min", cmd: "more5" },
      { label: "+10 min", cmd: "more10" },
      { label: cur ? "done ✓" : "finish ✓", cmd: "finish" },
      { label: "stop", cmd: "stop-now" },
    ],
  });
  startTimeUpCountdown(await FA.store.getActiveSession());
}

/** Tick the "stopping in Ns" line; at zero, stop the clock at the planned end. */
function startTimeUpCountdown(session) {
  stopTimeUpCountdown();
  if (!session?.timeUpAt) return;
  const deadline = session.timeUpAt + TIME_UP_GRACE_MS;
  const tick = async () => {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    const c = [...document.querySelectorAll("#work-messages .msg.k-timeup .countdown")].pop();
    if (c) c.textContent = left > 0 ? `stopping in ${left}s — tap +5 to keep going` : "stopping…";
    if (left <= 0) {
      stopTimeUpCountdown();
      const s = await FA.store.getActiveSession();
      if (s?.timeUpAt) {
        const m = current?.thread.filter((x) => x.kind === "timeup").pop();
        if (m) { m.used = true; await saveThread(); }
        await finishWork(false, { endedBy: "timeup", endedAt: plannedEnd(s) });
      }
    }
  };
  tick();
  timeUpTimer = setInterval(tick, 500);
}

function stopTimeUpCountdown() {
  clearInterval(timeUpTimer);
  timeUpTimer = null;
}

/** The "keep going?" card is answered — hide its buttons + countdown. */
async function retireTimeUpCard() {
  const m = current?.thread.filter((x) => x.kind === "timeup" && !x.used).pop();
  if (!m) return;
  m.used = true;
  renderThread();
  await saveThread();
}

/** "+N min": move the planned end, re-arm the worker's alarm, keep working. */
async function extendClock(minutes) {
  const s = await FA.store.getActiveSession();
  if (!s) return startSession(current.assignment, minutes).then(restoreClock);
  stopTimeUpCountdown();
  await retireTimeUpCard();
  await FA.store.updateActiveSession({ plannedMin: (s.plannedMin || 0) + minutes, timeUpAt: 0, checkpointFor: null });
  chrome.runtime.sendMessage({ type: "SESSION_STARTED", checkinMin: minutes }).catch(() => {});
  await restoreClock();
  return pushCoach(`+${minutes}. Same step, no new tabs.`, { kind: "nudge" });
}

/* ---- files: the memory that survives switching tabs ----
 * Each file: {id, kind: "gdoc"|"pdf"|"page"|"local", title, url, text, chars, addedAt, error}
 * `text` is cached here so the coach sees the reading whichever tab is active.
 * Capped per file and in total when sent to the brain (see filesForBrain). */
const FILE_TEXT_CAP = 60000;

async function saveFiles() {
  if (!current) return;
  await FA.store.patchAssignmentMeta(current.assignment.id, { files: current.files });
}

function renderFiles() {
  const list = $("files-list");
  list.innerHTML = "";
  if (!current) return;
  for (const f of current.files) {
    const chip = document.createElement("span");
    chip.className = "file-chip" + (f.loading ? " loading" : "") + (f.error ? " error" : "");
    const icon = f.kind === "gdoc" ? "📄" : f.kind === "pdf" ? "📕" : f.kind === "local" ? "📎" : f.kind === "snap" ? "📸" : "🌐";
    chip.innerHTML = `<span>${icon}</span><span class="f-title"></span><span class="f-size"></span><button class="f-x" title="detach">✕</button>`;
    chip.querySelector(".f-title").textContent = f.title || f.url || "file";
    chip.querySelector(".f-size").textContent = f.loading ? "reading…" : f.error ? "!" : f.chars ? `${Math.round(f.chars / 1000)}k` : "";
    chip.title = f.error ? `Couldn't read: ${f.error}` : f.url || f.title;
    if (f.url && !f.url.startsWith("local:")) {
      chip.querySelector(".f-title").style.cursor = "pointer";
      chip.querySelector(".f-title").addEventListener("click", () => openTab(f.url, true));
    }
    chip.querySelector(".f-x").addEventListener("click", async () => {
      current.files = current.files.filter((x) => x.id !== f.id);
      renderFiles();
      await saveFiles();
    });
    list.appendChild(chip);
  }
}

/** Read text for a file entry, by kind. Mutates + saves it. */
async function loadFileText(f) {
  f.loading = true;
  f.error = null;
  renderFiles();
  try {
    let text = "";
    if (f.kind === "gdoc") {
      const d = await FA.google.readDoc(f.url);
      text = d.text;
      if (d.title && !f.title) f.title = d.title;
    } else if (f.kind === "pdf") {
      const r = await FA.pdfText.fromUrl(f.url);
      text = r.text;
      f.pages = r.pages;
    } else if (f.kind === "page") {
      const [tab] = await chrome.tabs.query({ url: f.url.split("#")[0] + "*" });
      if (!tab?.id) throw new Error("open the page in a tab first");
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (document.querySelector("article, main, [role=main]") || document.body).innerText,
      });
      text = res?.result || "";
    }
    f.text = String(text || "").slice(0, FILE_TEXT_CAP);
    f.chars = f.text.length;
    if (!f.chars) f.error = "no text found";
  } catch (e) {
    f.error = e.message;
  }
  f.loading = false;
  renderFiles();
  await saveFiles();
}

/** Attach a URL (doc / pdf / page) to the current assignment, deduped. */
async function attachUrl(url, title = "", { silent = false } = {}) {
  if (!current || !url) return null;
  let kind = "page";
  let clean = url.split("#")[0];
  const pdf = pdfSourceFor(url);
  if (/docs\.google\.com\/document\/d\//.test(url)) {
    kind = "gdoc";
    clean = "https://docs.google.com/document/d/" + FA.google.docIdFrom(url) + "/edit";
  } else if (pdf) {
    kind = "pdf";
    clean = pdf;
  } else if (url.includes("/viewer/pdfjs/")) {
    kind = "pdf";
    const sp = new URL(url).searchParams;
    clean = sp.get("file") || sp.get("fa_file") || url;
  }
  if (current.files.some((f) => f.url === clean)) return null;
  const f = { id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind, title: title || "", url: clean, text: "", chars: 0, addedAt: Date.now() };
  current.files.push(f);
  renderFiles();
  await saveFiles();
  await loadFileText(f);
  if (!silent) await pushCoach(f.error ? `Attached “${f.title || clean}” but couldn't read it: ${f.error}` : `📎 I can see “${f.title || clean}” now (${Math.round(f.chars / 1000)}k chars) — for this assignment, whatever tab you're on.`, { kind: "nudge" });
  return f;
}

async function attachActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || /^chrome:/.test(tab.url)) return pushCoach("Switch to the tab with the reading, then tap + this tab.");
  // Drive-hosted files need the Drive host (for the cookie fallback) — ask now, inside the click.
  const pdf = pdfSourceFor(tab.url);
  if (pdf && isDriveUrl(pdf)) {
    try {
      await chrome.permissions.request({ origins: ["https://drive.google.com/*", "https://drive.usercontent.google.com/*"] });
    } catch {
      /* Drive API path may still work */
    }
  }
  if (tab.url.startsWith(chrome.runtime.getURL("")) && !tab.url.includes("/viewer/pdfjs/")) return;
  return attachUrl(tab.url, (tab.title || "").replace(/ - Google (Docs|Drive)$/, ""));
}

async function attachLocalFiles(fileList) {
  for (const file of fileList) {
    if (!current) return;
    const f = { id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind: "local", title: file.name, url: "local:" + file.name, text: "", chars: 0, addedAt: Date.now(), loading: true };
    current.files.push(f);
    renderFiles();
    try {
      if (/pdf$/i.test(file.name) || file.type === "application/pdf") {
        const r = await FA.pdfText.fromData(await file.arrayBuffer());
        f.text = r.text.slice(0, FILE_TEXT_CAP);
        f.pages = r.pages;
      } else {
        // Blob.text() is missing in some environments; FileReader always works.
        const raw = typeof file.text === "function"
          ? await file.text()
          : await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsText(file); });
        f.text = String(raw || "").slice(0, FILE_TEXT_CAP);
      }
      f.chars = f.text.length;
      if (!f.chars) f.error = "no text found (scanned PDF? try a photo instead)";
    } catch (e) {
      f.error = e.message;
    }
    f.loading = false;
    renderFiles();
    await saveFiles();
    await pushCoach(f.error ? `Attached “${file.name}” but couldn't read it: ${f.error}` : `📎 I can see “${file.name}” now (${Math.round(f.chars / 1000)}k chars).`, { kind: "nudge" });
  }
}

/** What the brain gets: every attached file's text (capped) + the student's highlights on them. */
async function filesForBrain() {
  if (!current?.files.length) return [];
  const PER = 14000;
  let budget = 48000;
  const out = [];
  const all = await chrome.storage.local.get(null);
  for (const f of current.files) {
    if (!f.text) continue;
    const slice = f.text.slice(0, Math.min(PER, budget));
    budget -= slice.length;
    let highlights = [];
    try {
      const u = new URL(f.url);
      const key = f.kind === "pdf" ? "fa-hl:" + f.url : "fa-hl:" + u.origin + u.pathname;
      highlights = (all[key] || []).map((h) => ({ quote: h.sel?.exact?.slice(0, 200), note: h.note || "" })).slice(0, 30);
    } catch {
      /* local file */
    }
    out.push({ title: f.title || f.url, kind: f.kind, text: slice, truncated: f.text.length > slice.length, highlights });
    if (budget <= 0) break;
  }
  return out;
}

$("files-add-tab").addEventListener("click", attachActiveTab);
$("files-add-local").addEventListener("click", () => $("files-input").click());
$("files-input").addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  await attachLocalFiles(files);
});
{
  const box = $("files");
  ["dragenter", "dragover"].forEach((ev) => box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.add("drop"); }));
  ["dragleave", "drop"].forEach((ev) => box.addEventListener(ev, () => box.classList.remove("drop")));
  box.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (!current) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) return attachLocalFiles(files);
    const url = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
    if (url && /^https?:/.test(url)) return attachUrl(url.trim());
  });
}

/* ---- checklist ---- */
async function saveSteps() {
  if (!current) return;
  await FA.store.patchAssignmentMeta(current.assignment.id, { steps: current.steps });
}

function renderSteps() {
  const wrap = $("steps");
  wrap.innerHTML = "";
  if (!current) return;
  const steps = current.steps;
  const doneCount = steps.filter((s) => s.done).length;
  const head = document.createElement("div");
  head.className = "steps-head";
  head.innerHTML = `<span>checklist</span><span class="muted">${doneCount}/${steps.length}</span>`;
  wrap.appendChild(head);

  steps.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "step" + (s.done ? " done" : "") + (i === steps.findIndex((x) => !x.done) ? " current" : "");
    row.innerHTML = `
      <input type="checkbox" ${s.done ? "checked" : ""} title="done" />
      <div class="step-body">
        <div class="step-text" contenteditable="true" spellcheck="false"></div>
        <div class="step-sub"><span class="step-est">${s.estMin} min</span>${s.deliverable ? ` · <span class="step-deliv"></span>` : ""}</div>
      </div>
      <button class="step-menu-btn" title="smaller · why · move · remove">⋯</button>`;
    row.querySelector(".step-text").textContent = s.text;
    if (s.deliverable) row.querySelector(".step-deliv").textContent = s.deliverable;

    row.querySelector("input").addEventListener("change", async (e) => {
      s.done = e.target.checked;
      s.doneBy = s.done ? "user" : null;
      s.doneAt = s.done ? Date.now() : null;
      renderSteps();
      await saveSteps();
      if (s.done && current.steps.every((x) => x.done)) {
        await pushCoach("Every step is checked. Turned in?", {
          kind: "checkpoint",
          actions: [{ label: "finish ✓", cmd: "finish" }, { label: "something's left", cmd: "add-step" }],
        });
      }
    });
    const textEl = row.querySelector(".step-text");
    textEl.addEventListener("blur", async () => {
      const t = textEl.textContent.trim().slice(0, 160);
      if (t && t !== s.text) {
        s.text = t;
        s.source = "user";
        await saveSteps();
      } else textEl.textContent = s.text;
    });
    textEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        textEl.blur();
      }
    });
    row.querySelector(".step-menu-btn").addEventListener("click", () => toggleStepMenu(row, s, i));
    wrap.appendChild(row);
  });
}

function toggleStepMenu(row, step, i) {
  const existing = row.querySelector(".step-menu");
  document.querySelectorAll(".step-menu").forEach((m) => m.remove());
  if (existing) return;
  const menu = document.createElement("div");
  menu.className = "step-menu";
  menu.innerHTML = `
    <button data-act="smaller" title="Split this into 2-3 smaller steps">smaller</button>
    <button data-act="why" title="Why this step matters for the grade">why</button>
    <button data-act="up" ${i === 0 ? "disabled" : ""}>↑</button>
    <button data-act="down" ${i === current.steps.length - 1 ? "disabled" : ""}>↓</button>
    <button data-act="remove" class="danger">remove</button>`;
  row.appendChild(menu);
  menu.addEventListener("click", async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    if (act === "smaller") {
      menu.textContent = FA.coachBrain === "claude" ? "🧠 splitting…" : "…";
      const subs = await Promise.resolve(FA.coach.splitStep(current.assignment, step));
      current.steps.splice(i, 1, ...subs);
    } else if (act === "why") {
      menu.remove();
      await sendWork(`Why does this step matter for the grade: "${step.text}"? One or two sentences.`);
      return;
    } else if (act === "up") {
      [current.steps[i - 1], current.steps[i]] = [current.steps[i], current.steps[i - 1]];
    } else if (act === "down") {
      [current.steps[i + 1], current.steps[i]] = [current.steps[i], current.steps[i + 1]];
    } else if (act === "remove") {
      current.steps.splice(i, 1);
    }
    renderSteps();
    await saveSteps();
  });
}

$("step-input").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || !current) return;
  const t = $("step-input").value.trim();
  if (!t) return;
  $("step-input").value = "";
  current.steps.push(...FA.normalizeSteps([{ text: t, estMin: 10 }], current.assignment, "user"));
  renderSteps();
  await saveSteps();
});

/* ---- the assignment's chat thread ---- */
async function saveThread() {
  if (!current) return;
  current.thread = current.thread.slice(-40);
  await FA.store.patchAssignmentMeta(current.assignment.id, { thread: current.thread });
}

function renderThread() {
  const wrap = $("work-messages");
  wrap.innerHTML = "";
  if (!current) return;
  if (!current.thread.length) {
    wrap.innerHTML = '<div class="empty-note small">the coach will set you up in a second…</div>';
    return;
  }
  for (const m of current.thread) {
    const el = document.createElement("div");
    el.className = "msg " + (m.role === "user" ? "me" : "coach") + (m.kind ? ` k-${m.kind}` : "");
    el.textContent = m.text;
    if (m.kind === "cards" && Array.isArray(m.cards)) renderCards(el, m.cards);
    if (m.kind === "test" && m.testId) renderTest(el, m);
    if (m.kind === "snap") renderSnap(el, m);
    if (m.kind === "timeup" && !m.used) {
      const c = document.createElement("span");
      c.className = "countdown";
      el.appendChild(c);
    }
    if (m.actions?.length && !m.used) {
      const row = document.createElement("div");
      row.className = "msg-actions";
      for (const a of m.actions) {
        const b = document.createElement("button");
        b.textContent = a.label;
        if (/finish|done/.test(a.cmd)) b.className = "primary";
        b.addEventListener("click", async () => {
          m.used = true;
          await saveThread();
          renderThread();
          runChip(a.cmd);
        });
        row.appendChild(b);
      }
      el.appendChild(row);
    }
    if (m.links?.length) {
      const row = document.createElement("div");
      row.className = "msg-links";
      for (const url of m.links) {
        const b = document.createElement("button");
        b.textContent = "+ open " + url.replace(/^https?:\/\//, "").slice(0, 34);
        b.addEventListener("click", () => chrome.tabs.create({ url, active: false }));
        row.appendChild(b);
      }
      el.appendChild(row);
    }
    wrap.appendChild(el);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

async function pushCoach(text, extra = {}) {
  if (!current) return;
  current.thread.push({ role: "coach", text, at: Date.now(), ...extra });
  renderThread();
  await saveThread();
}

function showWorkTyping() {
  const wrap = $("work-messages");
  const el = document.createElement("div");
  el.className = "msg coach";
  el.id = "work-typing";
  el.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
}

/** Read the Google Doc in the active tab, if there is one. */
async function readOpenDoc() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /docs\.google\.com\/document\/d\//.test(tab.url)) {
      const d = await FA.google.readDoc(tab.url);
      return { doc: { title: d.title || tab.title?.replace(/ - Google Docs$/, "") || "", text: d.text.slice(0, 30000), truncated: d.text.length > 30000 }, note: "" };
    }
  } catch (e) {
    return { doc: null, note: `Couldn't read the open doc: ${e.message}` };
  }
  return { doc: null, note: "" };
}

async function sendWork(text) {
  if (!current) return;
  const msg = (text ?? $("work-input").value).trim();
  if (!msg) return;
  $("work-input").value = "";

  // "check my draft" asked for a paste; this message IS the draft.
  if (current.awaitingDraft && !text) {
    current.awaitingDraft = false;
    current.thread.push({ role: "user", text: msg.length > 400 ? msg.slice(0, 400) + "…" : msg, at: Date.now() });
    renderThread();
    await saveThread();
    return runPrecheck(msg);
  }

  current.thread.push({ role: "user", text: msg, at: Date.now() });
  renderThread();
  await saveThread();
  showWorkTyping();

  const sessions = await FA.store.getSessions();
  const weekAgo = Date.now() - 7 * 86400000;
  const week = sessions.filter((s) => s.endedAt > weekAgo);
  const { doc, note } = await readOpenDoc();
  const session = await FA.store.getActiveSession();
  const files = await filesForBrain();
  const target = await docTarget(current.assignment); // assignment's doc, else the Google Doc in the active tab
  const googleConnected = await FA.google.isConnected().catch(() => false);

  const context = {
    ranked,
    brain: snapshot ? FA.snapshotForBrain(snapshot, { maxAssignments: 0 }) : null,
    mode: settings.mode || "tutor",
    doc,
    docNote: note,
    files,
    devMode: Boolean(settings.devMode),
    googleConnected,
    docTarget: target.id ? { id: target.id, url: target.url } : null,
    quiz: Boolean(current.quiz),
    focus: {
      assignment: current.assignment,
      steps: current.steps,
      elapsedMin: session ? Math.round((Date.now() - session.startedAt) / 60000) : 0,
    },
    stats: {
      streak: FA.computeStreak(sessions),
      sessionsThisWeek: week.length,
      minutesThisWeek: week.reduce((a, s) => a + s.actualMin, 0),
    },
  };

  const { reply } = await Promise.resolve(FA.coach.chat(current.thread, context));
  $("work-typing")?.remove();
  await pushCoach(await applyDocOpsFromReply(reply, target, googleConnected));
}

/**
 * Developer mode: the coach may answer with a fenced ```docops JSON block —
 * {"ops":[...], "summary": "..."} — meaning "write this into the doc". Apply
 * it and replace the block with what happened. Never in the student build.
 */
async function applyDocOpsFromReply(reply, target, googleConnected) {
  // Tolerant: the closing fence may be missing (models drop it, proxies strip
  // it), so take everything from the opening fence to the matching JSON brace.
  const text = String(reply || "");
  const open = text.search(/```docops\b/);
  if (open < 0) return reply;
  const start = text.indexOf("{", open);
  if (start < 0) return text.slice(0, open).trim() || reply;
  let depth = 0;
  let end = -1;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const after = end > 0 ? text.slice(end).replace(/^\s*```/, "") : "";
  const rest = (text.slice(0, open) + (end > 0 ? after : "")).trim();
  if (!settings.devMode) return rest || reply;
  if (end < 0) return `${rest}\n\n(the coach's doc edit was cut off before the JSON closed — ask it to send a shorter one)`;
  let block;
  try {
    block = JSON.parse(text.slice(start, end));
  } catch (e) {
    return `${rest}\n\n(the coach tried to edit the doc but sent malformed ops: ${e.message})`;
  }
  if (!target?.id) return `${rest}\n\n(the coach wanted to write into your doc, but this assignment has no doc yet — open one in a tab and tap + this tab)`;
  if (!googleConnected) return `${rest}\n\n(the coach wanted to write into your doc — connect Google first: ⚙ → connect G)`;
  try {
    const r = await FA.google.editDoc(target.id, block.ops || []);
    if (current) await FA.store.patchAssignmentMeta(current.assignment.id, { coachWrote: true });
    return `${rest}\n\n✍️ ${block.summary || "wrote into your doc"} (${r.applied} change${r.applied === 1 ? "" : "s"})`;
  } catch (e) {
    return `${rest}\n\n(couldn't write into the doc: ${e.message})`;
  }
}

/** 💡 Explain → a coach message. */
async function explainToChat() {
  const a = current.assignment;
  showWorkTyping();
  const brainCtx = snapshot ? FA.snapshotForBrain(snapshot, { maxAssignments: 0 }) : null;
  const r = await Promise.resolve(FA.coach.explain(a, brainCtx));
  $("work-typing")?.remove();
  const lines = [(r.fromClaude ? "🧠 " : "") + r.tldr];
  if (r.wants.length) lines.push("what the teacher wants:\n• " + r.wants.join("\n• "));
  if (r.traps.length) lines.push("traps:\n• " + r.traps.join("\n• "));
  lines.push(`▶ first move (~5 min): ${r.firstMove}\nwhole thing: ~${r.estMinutes} min`);
  await pushCoach(lines.join("\n\n"), { kind: "explain" });
}

/** 🔍 Pre-check → reads the doc we know about, else asks for a paste. */
async function precheckToChat() {
  const meta = await FA.store.getMeta();
  const docUrl = meta?.[current.assignment.id]?.docUrl;
  let draft = "";
  if (docUrl) {
    try {
      const d = await FA.google.readDoc(docUrl);
      draft = d.text.trim();
    } catch (e) {
      await pushCoach(`Couldn't read your doc (${e.message}). Paste the draft here and I'll check it.`);
      current.awaitingDraft = true;
      return;
    }
  } else {
    const { doc } = await readOpenDoc();
    draft = doc?.text?.trim() || "";
  }
  if (draft.length < 20) {
    await pushCoach("Paste your draft here (or open it in a Google Doc tab) and I'll check it against the assignment — pointers, not rewrites.");
    current.awaitingDraft = true;
    return;
  }
  return runPrecheck(draft);
}

async function runPrecheck(draft) {
  showWorkTyping();
  const r = await Promise.resolve(FA.coach.precheck(current.assignment, draft));
  $("work-typing")?.remove();
  const lines = [`${r.fromClaude ? "🧠 " : ""}estimate: ${r.grade}${r.fromClaude ? " (honest guess, not your teacher's grade)" : " — rules only; start the bridge for a real read"}`];
  if (r.strengths.length) lines.push("working:\n• " + r.strengths.join("\n• "));
  for (const i of r.issues) lines.push(`${i.quote ? `“${i.quote}”\n` : ""}${i.problem}\n→ ${i.hint}`);
  if (r.missing.length) lines.push("not addressed yet:\n• " + r.missing.join("\n• "));
  lines.push(`▶ ${r.nextStep}`);
  await pushCoach(lines.join("\n\n"), { kind: "precheck" });
}

/** Chip commands inside the work view. */
async function runChip(cmd) {
  if (!current) return;
  const cur = current.steps.find((s) => !s.done);
  switch (cmd) {
    case "explain":
      return explainToChat();
    case "breakdown": {
      // Keep checked steps; regenerate the rest from the instructions.
      showWorkTyping();
      const fresh = await Promise.resolve(FA.coach.breakdownSteps(current.assignment));
      $("work-typing")?.remove();
      current.steps = [...current.steps.filter((s) => s.done), ...fresh];
      renderSteps();
      await saveSteps();
      return pushCoach(`New checklist: ${fresh.length} steps, first one under 5 minutes. Edit anything that's wrong — tap ⋯ on a step for smaller.`);
    }
    case "precheck":
      return precheckToChat();
    case "stuck":
      return sendWork(cur ? `I'm stuck on this step: "${cur.text}". What's the smallest next thing I can do?` : "I'm stuck. What's the smallest next thing I can do?");
    case "more5":
      return extendClock(5);
    case "more10":
      return extendClock(10);
    case "stop-now": {
      const s = await FA.store.getActiveSession();
      stopTimeUpCountdown();
      return finishWork(false, s?.timeUpAt ? { endedBy: "timeup", endedAt: plannedEnd(s) } : {});
    }
    case "snap":
      return snapScreen({ question: $("work-input").value.trim() });
    case "step-done": {
      if (cur) {
        cur.done = true;
        cur.doneBy = "user";
        cur.doneAt = Date.now();
        renderSteps();
        await saveSteps();
      }
      return;
    }
    case "finish":
      return finishWork(true);
    case "add-step":
      $("step-input").focus();
      return;
    case "format":
      return formatMyDoc();
    case "clear": {
      current.thread = [];
      current.quiz = false;
      renderThread();
      await saveThread();
      return;
    }
    case "idle-yes":
      chrome.runtime.sendMessage({ type: "ACTIVITY" }).catch(() => {});
      await FA.store.updateActiveSession({ lastActiveAt: Date.now(), idleAskAt: 0 });
      await restoreClock();
      return pushCoach("Clock's running. Carry on.", { kind: "nudge" });
    case "idle-stop":
      return finishWork(false);
    case "more": {
      // ⋯ reveals the secondary chips; tap again to tuck them away.
      const row = $("work-chips");
      const open = row.classList.toggle("expanded");
      const btn = row.querySelector(".chat-chip.more");
      if (btn) btn.textContent = open ? "less" : "⋯";
      return;
    }
    case "quiz":
      current.quiz = !current.quiz;
      if (!current.quiz) return pushCoach("Quiz over. Ask me anything or hit quiz me to go again.", { kind: "nudge" });
      return sendWork(current.files.length ? "Quiz me on what's in my files. One question at a time." : "Quiz me on this topic. One question at a time.");
    case "flashcards":
      return makeFlashcards();
    case "test":
      return showPracticeTest();
    case "studyplan":
      return makeStudyPlan();
    case "dev-edit":
      return devEditDoc();
    case "dev-autopilot":
      return runAutopilot(current.assignment);
    case "dev-write":
      return devWriteStep(cur);
    case "dev-answer":
      return devAnswerAll();
    case "dev-photo":
      $("photo-input").click();
      return;
    case "dev-complete":
      return devMarkComplete(current.assignment);
  }
}

/* ------------------------------------------------------------------ *
 * Study mode (tests): flashcards · quiz · study plan
 * ------------------------------------------------------------------ */
async function makeFlashcards() {
  showWorkTyping();
  const files = await filesForBrain();
  const r = await Promise.resolve(FA.coach.flashcards(current.assignment, files));
  $("work-typing")?.remove();
  if (!r.cards?.length) return pushCoach(r.error || "Attach the reading or your notes (+ this tab) and I'll make cards from them.");
  return pushCoach(`${r.fromClaude ? "🧠 " : ""}${r.cards.length} cards — tap one to flip. “copy for Quizlet” puts them on your clipboard as term ⇥ definition.`, { kind: "cards", cards: r.cards });
}

async function makeStudyPlan() {
  showWorkTyping();
  const topics = snapshot?.topics?.[current.assignment.sectionId] || [];
  const files = await filesForBrain();
  const r = await Promise.resolve(FA.coach.studyPlan(current.assignment, { topics, files }));
  $("work-typing")?.remove();
  if (!r.sessions?.length) return pushCoach(r.error || "I need a due date on the test to spread the studying out.");
  const steps = FA.normalizeSteps(r.sessions.map((s) => ({ text: `📅 ${s.day}: ${s.text}`, deliverable: s.deliverable || "", estMin: s.estMin || 20 })), current.assignment, r.fromClaude ? "claude" : "rules");
  current.steps = [...current.steps.filter((s) => s.done), ...steps];
  renderSteps();
  await saveSteps();
  return pushCoach(`${r.fromClaude ? "🧠 " : ""}Study plan: ${steps.length} sessions between now and the test, added to your checklist. ${r.note || ""}`.trim(), { kind: "nudge" });
}

/** Cards render inside the thread as flip cards + a Quizlet export. */
function renderCards(el, cards) {
  const wrap = document.createElement("div");
  wrap.className = "cards";
  for (const c of cards) {
    const card = document.createElement("div");
    card.className = "fcard";
    card.innerHTML = `<div class="q"></div><div class="a"></div><div class="hint">tap to flip</div>`;
    card.querySelector(".q").textContent = c.q;
    card.querySelector(".a").textContent = c.a;
    card.addEventListener("click", () => card.classList.toggle("flip"));
    wrap.appendChild(card);
  }
  const row = document.createElement("div");
  row.className = "msg-actions";
  const b = document.createElement("button");
  b.textContent = "copy for Quizlet";
  b.title = "Quizlet → Create set → Import: paste, 'tab' between term and definition, 'new line' between cards";
  b.addEventListener("click", async () => {
    const tsv = cards.map((c) => `${c.q.replace(/\t|\n/g, " ")}\t${c.a.replace(/\t|\n/g, " ")}`).join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      b.textContent = "copied ✓ — Quizlet → Import";
    } catch {
      b.textContent = "copy failed";
    }
  });
  row.appendChild(b);
  el.appendChild(wrap);
  el.appendChild(row);
}

/* ------------------------------------------------------------------ *
 * 📸 Screen annotate — for everything the text highlighter can't touch:
 * Google Docs (canvas, no selection), Drive previews, images, diagrams,
 * scanned pages. Screenshot the visible tab (our own pixels, nothing read
 * from the page), let the student drag a region, send it to the brain:
 * no question → a page overview (what it is, key ideas, questions to be
 * able to answer, quotes worth highlighting); a question typed in the box
 * → an answer about what's visible. The transcribed text joins the
 * assignment's files so summaries / quizzes / practice tests can use it.
 * Only ever user-initiated; the full image is never stored — a small
 * thumbnail lives in the thread.
 * ------------------------------------------------------------------ */
async function snapScreen({ question = "" } = {}) {
  if (!current) {
    const b = $("snap-btn");
    b.textContent = "open an assignment first";
    setTimeout(() => (b.textContent = "📸"), 2200);
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || /^chrome:/.test(tab.url)) return pushCoach("Switch to the tab you want me to look at, then tap 📸.");
  // Screenshots need the site's permission (optional host permission, asked inside the click).
  let origin = "";
  try {
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) origin = u.origin;
  } catch {
    /* extension page etc. */
  }
  if (origin) {
    try {
      await chrome.permissions.request({ origins: [origin + "/*"] });
    } catch {
      /* captureVisibleTab will tell us */
    }
  }
  // Drag-to-crop overlay; click = whole screen; Esc = cancel. Pages we can't inject into → whole screen.
  let region = "all";
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["annotate/snip.js"] });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__faSnip() });
    region = res?.result ?? null;
    if (region === null) return; // Esc
  } catch {
    region = "all";
  }
  let shot;
  try {
    shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (e) {
    return pushCoach(`Couldn't screenshot this tab (${e.message}). Chrome blocks a few pages — try “+ this tab” or the highlighter instead.`);
  }
  let full, thumb;
  try {
    ({ full, thumb } = await cropShot(shot, region));
  } catch {
    return pushCoach("Couldn't process the screenshot.");
  }
  showWorkTyping();
  const page = { title: (tab.title || "").replace(/ - Google (Docs|Drive|Slides|Sheets)$/, ""), host: origin.replace(/^https?:\/\//, "") };
  const r = await Promise.resolve(FA.coach.readScreen(current.assignment, full, { question, page }));
  $("work-typing")?.remove();
  if (!r.fromClaude) return pushCoach(r.error || "The coach couldn't read the screen.");
  if (question) $("work-input").value = "";
  // The page's text joins the files (once per page title + snap) so the rest of the coach can use it.
  if (r.text && r.text.length > 40) {
    const f = { id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind: "snap", title: `📸 ${page.title || page.host || "screen"}`, url: tab.url.split("#")[0] + "#snap" + Date.now().toString(36), text: r.text, chars: r.text.length, addedAt: Date.now() };
    current.files.push(f);
    renderFiles();
    await saveFiles();
  }
  const text = question ? r.answer : r.what;
  return pushCoach(text || "Here's what I see:", { kind: "snap", thumb, question, keyIdeas: r.keyIdeas, questions: r.questions, quotes: r.quotes });
}

/** Crop the capture to the dragged region (device pixels) and downscale; also make a thread thumbnail. */
function cropShot(dataUrl, region) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (region && region !== "all") {
        const d = region.dpr || 1;
        sx = Math.max(0, Math.round(region.x * d));
        sy = Math.max(0, Math.round(region.y * d));
        sw = Math.min(img.width - sx, Math.round(region.w * d));
        sh = Math.min(img.height - sy, Math.round(region.h * d));
      }
      const draw = (maxW, q) => {
        const scale = Math.min(1, maxW / sw);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(sw * scale));
        c.height = Math.max(1, Math.round(sh * scale));
        c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        return c.toDataURL("image/jpeg", q);
      };
      resolve({ full: draw(1600, 0.85), thumb: draw(360, 0.6) });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** A snap message: thumbnail + the overview sections (or just the answer). */
function renderSnap(el, m) {
  if (m.thumb) {
    const img = document.createElement("img");
    img.className = "snap-img";
    img.src = m.thumb;
    img.alt = "screenshot";
    el.insertBefore(img, el.firstChild);
  }
  const section = (label, items, numbered = false) => {
    if (!items?.length) return;
    const d = document.createElement("div");
    d.className = "snap-sec";
    const b = document.createElement("b");
    b.textContent = label;
    d.appendChild(b);
    const ul = document.createElement(numbered ? "ol" : "ul");
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = it;
      ul.appendChild(li);
    }
    d.appendChild(ul);
    el.appendChild(d);
  };
  if (m.question) {
    const q = document.createElement("div");
    q.className = "snap-sec";
    q.textContent = `you asked: ${m.question}`;
    el.insertBefore(q, el.firstChild);
  }
  section("key ideas", m.keyIdeas);
  section("be able to answer", m.questions, true);
  section("worth highlighting", m.quotes?.map((x) => `“${x}”`));
}

/* ------------------------------------------------------------------ *
 * Practice test: a graded test inside the thread. Questions come from the
 * brain (files + highlights), the student can add / edit / delete any of
 * them, retake only the misses, ask for more or harder ones, and copy the
 * whole thing into Quizlet. Tests persist per assignment (meta.tests), the
 * thread message just points at one by id, so "clear chat" keeps the test.
 * ------------------------------------------------------------------ */
const Q_LETTERS = "ABCDEFGH";
const Q_TYPE_LABEL = { mcq: "multiple choice", tf: "true / false", short: "short answer", flashcard: "flashcard" };

async function saveTests() {
  if (!current) return;
  current.tests = current.tests.slice(-6);
  await FA.store.patchAssignmentMeta(current.assignment.id, { tests: current.tests });
}

const qPrompt = (q) => (q.type === "flashcard" ? q.term : q.type === "tf" ? q.statement : q.question);
const qAnswerText = (q) =>
  q.type === "flashcard" ? q.definition : q.type === "mcq" ? `${Q_LETTERS[q.answer]}. ${q.choices[q.answer]}` : q.type === "tf" ? (q.answer ? "True" : "False") : q.answer;

/** Chip: bring the latest test back, or build the first one. */
async function showPracticeTest() {
  const latest = current.tests[current.tests.length - 1];
  if (latest) {
    const last = current.thread[current.thread.length - 1];
    if (last?.kind === "test" && last.testId === latest.id) return; // already on screen
    return pushCoach(`Your practice test (${latest.questions.length} q). “new test” builds a fresh one.`, { kind: "test", testId: latest.id });
  }
  return buildPracticeTest({});
}

/** Build a new test, or extend the current one (`extend`) with more / harder / focused questions. */
async function buildPracticeTest({ extend = null, count = 10, harder = false, topic = "" }) {
  showWorkTyping();
  const files = await filesForBrain();
  const avoid = extend ? extend.questions.map(qPrompt) : [];
  const r = await Promise.resolve(FA.coach.practiceTest(current.assignment, { files, count, harder, topic, avoid }));
  $("work-typing")?.remove();
  if (!r.questions?.length) return pushCoach(r.error || "Attach the reading or your notes (+ this tab) and I'll build a test from them.");
  if (extend) {
    extend.questions = [...extend.questions, ...r.questions].slice(0, 60);
    await saveTests();
    return pushCoach(`${r.fromClaude ? "🧠 " : ""}Added ${r.questions.length} ${harder ? "harder " : ""}questions — ${extend.questions.length} total now.`, { kind: "test", testId: extend.id });
  }
  const t = { id: "t" + Date.now().toString(36), title: r.title || "Practice test", questions: r.questions, attempts: [], lastMissed: [], createdAt: Date.now() };
  current.tests.push(t);
  await saveTests();
  const mix = Object.entries(r.questions.reduce((m, q) => ((m[q.type] = (m[q.type] || 0) + 1), m), {})).map(([k, v]) => `${v} ${Q_TYPE_LABEL[k]}`).join(", ");
  return pushCoach(`${r.fromClaude ? "🧠 " : ""}${r.questions.length} questions (${mix}). Answer, then submit — I'll grade it and you can retake just the misses. ✎ fixes any question; “+ my own” adds one.`, { kind: "test", testId: t.id });
}

/** The test card inside a thread message. `m.draft` keeps typed answers across re-renders. */
function renderTest(el, m) {
  const t = current?.tests.find((x) => x.id === m.testId);
  if (!t) return;
  // Only the newest message pointing at this test renders the whole thing.
  const newest = current.thread.filter((x) => x.kind === "test" && x.testId === t.id).pop();
  if (newest !== m) {
    el.textContent = "practice test ↓ (it moved below)";
    el.classList.add("k-nudge");
    return;
  }
  m.draft = m.draft || {};
  m.order = m.order || {};
  const missedOnly = m.mode === "missed";
  const qs = missedOnly ? t.questions.filter((q) => t.lastMissed.includes(q.id)) : t.questions;
  const res = m.result || null;

  const box = document.createElement("div");
  box.className = "ptest";
  const head = document.createElement("div");
  head.className = "ptest-head";
  const best = t.attempts.length ? Math.max(...t.attempts.map((a) => Math.round((100 * a.score) / a.total))) : null;
  head.textContent = `${t.title} · ${qs.length} q${missedOnly ? " (misses only)" : ""}${best != null ? ` · best ${best}%` : ""}`;
  box.appendChild(head);

  qs.forEach((q, i) => {
    const card = document.createElement("div");
    card.className = "pq";
    card.dataset.qid = q.id;
    const graded = Boolean(res) && q.id in res.byId; // added after grading → not part of this attempt
    const verdict = graded ? res.byId[q.id] : undefined;
    if (verdict === true) card.classList.add("right");
    if (verdict === false) card.classList.add("wrong");
    const top = document.createElement("div");
    top.className = "pq-top";
    top.innerHTML = `<span class="pq-n"></span><button class="pq-edit" title="Edit this question">✎</button>`;
    top.querySelector(".pq-n").textContent = `${i + 1} · ${Q_TYPE_LABEL[q.type]}`;
    top.querySelector(".pq-edit").addEventListener("click", () => openQuestionEditor(card, t, q, m));
    card.appendChild(top);
    const prompt = document.createElement("div");
    prompt.className = "pq-q";
    prompt.textContent = q.type === "tf" ? `True or false: ${q.statement}` : qPrompt(q);
    card.appendChild(prompt);

    const locked = graded;
    if (q.type === "mcq") {
      if (!m.order[q.id]) m.order[q.id] = q.choices.map((_, k) => k).sort(() => Math.random() - 0.5);
      m.order[q.id].forEach((k, pos) => {
        if (k >= q.choices.length) return;
        const lab = document.createElement("label");
        lab.className = "choice";
        const r = document.createElement("input");
        r.type = "radio"; r.name = `pq-${m.testId}-${q.id}`; r.value = String(k); r.disabled = locked;
        r.checked = m.draft[q.id] === String(k);
        r.addEventListener("change", () => { m.draft[q.id] = r.value; });
        lab.appendChild(r);
        lab.appendChild(document.createTextNode(` ${Q_LETTERS[pos]}. ${q.choices[k]}`));
        card.appendChild(lab);
      });
    } else if (q.type === "tf") {
      ["true", "false"].forEach((v) => {
        const lab = document.createElement("label");
        lab.className = "choice";
        const r = document.createElement("input");
        r.type = "radio"; r.name = `pq-${m.testId}-${q.id}`; r.value = v; r.disabled = locked;
        r.checked = m.draft[q.id] === v;
        r.addEventListener("change", () => { m.draft[q.id] = r.value; });
        lab.appendChild(r);
        lab.appendChild(document.createTextNode(v === "true" ? " True" : " False"));
        card.appendChild(lab);
      });
    } else {
      const inp = document.createElement("input");
      inp.type = "text"; inp.placeholder = q.type === "flashcard" ? "the definition" : "your answer"; inp.autocomplete = "off"; inp.disabled = locked;
      inp.value = m.draft[q.id] || "";
      inp.addEventListener("input", () => { m.draft[q.id] = inp.value; });
      card.appendChild(inp);
    }

    if (graded) {
      const v = document.createElement("div");
      v.className = "pq-verdict";
      if (verdict === true) v.textContent = "✓ correct";
      else if (verdict === false) v.textContent = `✗ answer: ${qAnswerText(q)}`;
      else {
        v.textContent = `answer: ${qAnswerText(q)} `;
        const yes = document.createElement("button"); yes.textContent = "I got it"; yes.className = "mini-btn";
        const no = document.createElement("button"); no.textContent = "missed it"; no.className = "mini-btn";
        yes.addEventListener("click", () => settleSelfMark(m, t, q.id, true));
        no.addEventListener("click", () => settleSelfMark(m, t, q.id, false));
        v.appendChild(yes); v.appendChild(no);
      }
      card.appendChild(v);
      if (q.explanation && verdict !== true) {
        const ex = document.createElement("div"); ex.className = "pq-expl"; ex.textContent = q.explanation; card.appendChild(ex);
      }
    }
    box.appendChild(card);
  });

  if (res) {
    const sc = document.createElement("div");
    sc.className = "ptest-score";
    sc.textContent = `Score: ${res.score} / ${res.total} (${Math.round((100 * res.score) / Math.max(res.total, 1))}%)${res.pending ? ` · ${res.pending} to self-mark` : ""}`;
    box.appendChild(sc);
  }

  const row = document.createElement("div");
  row.className = "msg-actions";
  const btn = (label, fn, primary = false, title = "") => {
    const b = document.createElement("button"); b.textContent = label; b.title = title; if (primary) b.className = "primary";
    b.addEventListener("click", fn); row.appendChild(b); return b;
  };
  if (!res) btn("submit", () => gradeTest(m, t, qs), true);
  else {
    if (t.lastMissed.length) btn(`retake misses (${t.lastMissed.length})`, async () => { m.mode = "missed"; m.result = null; m.draft = {}; renderThread(); await saveThread(); }, true);
    if (missedOnly) btn("whole test again", async () => { m.mode = "all"; m.result = null; m.draft = {}; renderThread(); await saveThread(); });
    else btn("take again", async () => { m.result = null; m.draft = {}; m.order = {}; renderThread(); await saveThread(); });
    btn("more like the misses", () => buildPracticeTest({ extend: t, count: 6, topic: t.lastMissed.length ? "the ideas behind these missed questions: " + t.questions.filter((q) => t.lastMissed.includes(q.id)).map(qPrompt).slice(0, 8).join(" | ") : "" }), false, "6 new questions on the same ideas");
    btn("harder", () => buildPracticeTest({ extend: t, count: 6, harder: true }), false, "6 application-level questions");
  }
  btn("+ my own", () => openQuestionEditor(null, t, null, m), false, "Write a question yourself");
  const qz = btn("copy for Quizlet", async () => {
    const line = (s) => String(s || "").replace(/\t|\n/g, " ");
    const tsv = t.questions
      .map((q) => (q.type === "mcq" ? `${line(q.question)} ${q.choices.map((c, k) => `${Q_LETTERS[k]}. ${line(c)}`).join(" / ")}` : line(q.type === "tf" ? `True or false: ${q.statement}` : qPrompt(q))) + "\t" + line(qAnswerText(q)))
      .join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      qz.textContent = "copied ✓";
      btn("open Quizlet ↗", () => chrome.tabs.create({ url: "https://quizlet.com/create-set", active: true }), false, "Create set → + Import → paste (tab / new line)");
    } catch {
      qz.textContent = "copy failed";
    }
  }, false, "Term ⇥ answer, one per line. Quizlet → Create set → + Import → paste.");
  btn("new test", () => buildPracticeTest({}), false, "Build a fresh test from your files");
  box.appendChild(row);
  el.appendChild(box);
}

function gradeTest(m, t, qs) {
  const byId = {};
  let score = 0, pending = 0;
  for (const q of qs) {
    const d = m.draft[q.id];
    let ok;
    if (q.type === "mcq") ok = d != null && Number(d) === q.answer;
    else if (q.type === "tf") ok = d != null && (d === "true") === q.answer;
    else {
      ok = FA.checkShortAnswer(q, d || "");
      // A wrong-looking typed answer (or any flashcard) gets self-marked; blank = missed.
      if (!ok && (q.type === "flashcard" || String(d || "").trim())) { ok = null; pending++; }
    }
    byId[q.id] = ok;
    if (ok === true) score++;
  }
  m.result = { at: Date.now(), byId, score, total: qs.length, pending };
  recordAttempt(m, t);
  renderThread();
  const wrap = $("work-messages");
  wrap.querySelector(".ptest-score")?.scrollIntoView({ block: "nearest" });
}

async function settleSelfMark(m, t, qid, ok) {
  if (!m.result || m.result.byId[qid] !== null) return;
  m.result.byId[qid] = ok;
  if (ok) m.result.score++;
  m.result.pending = Math.max(0, m.result.pending - 1);
  recordAttempt(m, t);
  renderThread();
}

/** Latest attempt row on the test (self-marks update it in place). */
function recordAttempt(m, t) {
  const r = m.result;
  const missed = Object.entries(r.byId).filter(([, ok]) => ok === false).map(([id]) => id);
  const row = { at: r.at, score: r.score, total: r.total, missed };
  const i = t.attempts.findIndex((a) => a.at === r.at);
  if (i >= 0) t.attempts[i] = row; else t.attempts.push(row);
  t.attempts = t.attempts.slice(-20);
  // Misses carry over: a retake of the misses only clears what you got right this time.
  const asked = new Set(Object.keys(r.byId));
  t.lastMissed = [...new Set([...t.lastMissed.filter((id) => !asked.has(id) || r.byId[id] === false), ...missed])].filter((id) => t.questions.some((q) => q.id === id));
  saveTests();
  saveThread();
}

/**
 * Inline editor for one question (or a new one when q is null). Type
 * switches the fields; save validates through FA.normalizeQuestions so a
 * half-filled question can't land on the test.
 */
function openQuestionEditor(card, t, q, m) {
  document.querySelectorAll(".pq-editor").forEach((e) => e.remove());
  const ed = document.createElement("div");
  ed.className = "pq-editor";
  const type = q?.type || "mcq";
  ed.innerHTML = `
    <select class="pe-type">
      <option value="mcq">multiple choice</option><option value="tf">true / false</option>
      <option value="short">short answer</option><option value="flashcard">flashcard</option>
    </select>
    <textarea class="pe-q" rows="2" placeholder="question / statement / term"></textarea>
    <textarea class="pe-choices" rows="4" placeholder="choices, one per line"></textarea>
    <input class="pe-answer" type="text" placeholder="answer" />
    <input class="pe-accept" type="text" placeholder="other accepted answers, comma-separated" />
    <input class="pe-expl" type="text" placeholder="explanation (optional)" />
    <div class="msg-actions"><button class="primary pe-save">save</button><button class="pe-cancel">cancel</button>${q ? '<button class="pe-del">delete</button>' : ""}</div>`;
  const sel = ed.querySelector(".pe-type");
  sel.value = type;
  const fill = () => {
    const ty = sel.value;
    ed.querySelector(".pe-choices").hidden = ty !== "mcq";
    ed.querySelector(".pe-accept").hidden = ty !== "short";
    const ans = ed.querySelector(".pe-answer");
    ans.placeholder = ty === "mcq" ? "correct letter (A-D)" : ty === "tf" ? "true or false" : ty === "flashcard" ? "definition" : "answer";
  };
  sel.addEventListener("change", fill);
  fill();
  if (q) {
    ed.querySelector(".pe-q").value = qPrompt(q);
    ed.querySelector(".pe-choices").value = (q.choices || []).join("\n");
    ed.querySelector(".pe-answer").value = q.type === "mcq" ? Q_LETTERS[q.answer] : q.type === "tf" ? String(q.answer) : q.type === "flashcard" ? q.definition : q.answer;
    ed.querySelector(".pe-accept").value = (q.accept || []).join(", ");
    ed.querySelector(".pe-expl").value = q.explanation || "";
  }
  ed.querySelector(".pe-cancel").addEventListener("click", () => ed.remove());
  ed.querySelector(".pe-del")?.addEventListener("click", async () => {
    t.questions = t.questions.filter((x) => x.id !== q.id);
    t.lastMissed = t.lastMissed.filter((id) => id !== q.id);
    if (m.result) { delete m.result.byId[q.id]; }
    await saveTests();
    renderThread();
  });
  ed.querySelector(".pe-save").addEventListener("click", async () => {
    const ty = sel.value;
    const text = ed.querySelector(".pe-q").value.trim();
    const answer = ed.querySelector(".pe-answer").value.trim();
    const raw = { type: ty, explanation: ed.querySelector(".pe-expl").value.trim() };
    if (ty === "mcq") Object.assign(raw, { question: text, choices: ed.querySelector(".pe-choices").value.split("\n").map((c) => c.trim()).filter(Boolean), answer });
    else if (ty === "tf") Object.assign(raw, { statement: text, answer });
    else if (ty === "short") Object.assign(raw, { question: text, answer, accept: ed.querySelector(".pe-accept").value.split(",").map((c) => c.trim()).filter(Boolean) });
    else Object.assign(raw, { term: text, definition: answer });
    const [clean] = FA.normalizeQuestions([raw]);
    if (!clean) {
      ed.querySelector(".pe-save").textContent = ty === "mcq" ? "needs 2+ choices + a correct letter" : "needs a question and an answer";
      return;
    }
    if (q) {
      clean.id = q.id;
      t.questions = t.questions.map((x) => (x.id === q.id ? clean : x));
      delete m.order?.[q.id];
    } else t.questions.push(clean);
    await saveTests();
    renderThread();
  });
  if (card) card.appendChild(ed);
  else {
    const box = document.querySelector(`#work-messages .ptest`);
    (box || $("work-messages")).appendChild(ed);
    ed.scrollIntoView({ block: "nearest" });
  }
  ed.querySelector(".pe-q").focus();
}

/* ------------------------------------------------------------------ *
 * Other schools: connect a portal by hand, and ship debug info instead of "it broke"
 * ------------------------------------------------------------------ */
async function connectPortalFromTab() {
  const note = $("portal-note");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    note.textContent = "open your school's assignment page in a tab first";
    return;
  }
  const origin = new URL(tab.url).origin;
  note.textContent = "checking…";
  try {
    const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
    if (!granted) {
      note.textContent = "permission declined";
      return;
    }
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["adapters/schema.js", "adapters/detect.js"] }).then(() =>
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.FA?.detectPortal?.() || null })
    );
    const d = res?.result;
    if (!d) {
      note.textContent = "couldn't inspect that page";
      return;
    }
    if (!d.supported) {
      note.textContent = `${d.type === "unknown" ? "not a school portal we recognise" : d.type + " isn't supported yet"} — tap copy debug info and send it to Ben`;
      return;
    }
    const { customPortals = {} } = await chrome.storage.local.get("customPortals");
    customPortals[origin] = d.type;
    await chrome.storage.local.set({ customPortals });
    if (!PORTAL_URL_PATTERNS.includes(origin + "/*")) PORTAL_URL_PATTERNS.push(origin + "/*");
    await FA.store.setSettings({ dataSource: "auto" });
    note.textContent = `${d.type} connected on ${new URL(tab.url).hostname} — reading assignments…`;
    // The worker registers the scripts on storage change; inject now for this tab.
    await new Promise((r) => setTimeout(r, 400));
    await chrome.runtime.sendMessage({ type: "REINJECT" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    await loadAssignments();
    await refreshAll();
    note.textContent = `${d.type} connected · ${assignments.length} assignments${sourceNotice ? " · " + sourceNotice : ""}`;
  } catch (e) {
    note.textContent = `couldn't connect: ${e.message}`;
  }
}

/** Everything a tester can safely send: what we saw, never who they are. */
async function copyDebugInfo() {
  const btn = $("debug-btn");
  const info = {
    version: chrome.runtime.getManifest().version,
    when: new Date().toISOString(),
    brain: FA.coachBrain,
    bridge: FA.bridgeHealth ? { stale: FA.bridgeHealth.stale, methods: FA.bridgeHealth.methods?.length } : null,
    settings: { dataSource: settings.dataSource, mode: settings.mode, devMode: Boolean(settings.devMode) },
    sourceNotice,
    assignments: { count: assignments.length, source: assignments[0]?.source || null, types: [...new Set(assignments.map((a) => a.type))], sampleKeys: assignments[0]?.raw ? Object.keys(assignments[0].raw).slice(0, 40) : [] },
    snapshot: snapshot ? { classes: snapshot.classes?.length, schedule: snapshot.schedule?.length, errors: snapshot.errors || [] } : null,
    customPortals: (await chrome.storage.local.get("customPortals")).customPortals || {},
    portalTabs: [],
    ua: navigator.userAgent,
  };
  try {
    const tabs = await chrome.tabs.query({ url: PORTAL_URL_PATTERNS });
    for (const tab of tabs.slice(0, 4)) {
      let det = null;
      try {
        det = await chrome.tabs.sendMessage(tab.id, { type: "DETECT_PORTAL" });
      } catch (e) {
        det = { error: "no content script (reload the tab)" };
      }
      info.portalTabs.push({ host: new URL(tab.url).hostname, path: new URL(tab.url).pathname.slice(0, 60), ...det });
    }
    // Also the active tab, in case it's an unrecognised portal.
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.url && /^https?:/.test(active.url) && !tabs.some((t) => t.id === active.id)) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: active.id }, files: ["adapters/schema.js", "adapters/detect.js"] });
        const [r] = await chrome.scripting.executeScript({ target: { tabId: active.id }, func: () => globalThis.FA?.detectPortal?.() || null });
        info.activeTab = { host: new URL(active.url).hostname, ...(r?.result || {}) };
      } catch {
        info.activeTab = { host: new URL(active.url).hostname, note: "no access (tap connect my school first)" };
      }
    }
  } catch {
    /* fine */
  }
  const text = "Focus Agent debug info\n" + JSON.stringify(info, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "copied ✓ — paste it to Ben";
  } catch {
    btn.textContent = "copy failed";
  }
  setTimeout(() => (btn.textContent = "copy debug info"), 4000);
}
$("connect-portal-btn").addEventListener("click", connectPortalFromTab);
$("debug-btn").addEventListener("click", copyDebugInfo);

/* ------------------------------------------------------------------ *
 * Your writing voice — samples in, profile out, every writing prompt uses it
 * ------------------------------------------------------------------ */
async function renderVoice() {
  const [samples, guide, profile] = await Promise.all([FA.voice.samples(), FA.voice.guide(), FA.voice.profile()]);
  const list = $("voice-list");
  list.innerHTML = "";
  for (const s of samples) {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    const icon = s.source === "gdoc" || s.source === "drive" ? "📄" : s.source === "auto" ? "✨" : s.source === "file" ? "📎" : "✍️";
    chip.innerHTML = `<span>${icon}</span><span class="f-title"></span><span class="f-size"></span><button class="f-x" title="remove">✕</button>`;
    chip.querySelector(".f-title").textContent = s.title;
    chip.querySelector(".f-size").textContent = `${s.words}w`;
    chip.title = s.text.slice(0, 200);
    chip.querySelector(".f-x").addEventListener("click", async () => {
      await FA.voice.removeSample(s.id);
      scheduleVoiceRebuild();
      renderVoice();
    });
    list.appendChild(chip);
  }
  $("voice-guide-note").textContent = guide ? `imported ${new Date(guide.importedAt).toLocaleDateString()} (${guide.source})` : "none yet";
  $("voice-auto-toggle").checked = settings.voiceAuto !== false;
  const box = $("voice-profile");
  if (profile?.profile) {
    box.textContent = `${profile.fromClaude ? "🧠 " : "⚙️ "}${profile.profile}` + (profile.traits?.length ? `\n• ${profile.traits.slice(0, 6).join("\n• ")}` : "");
  } else box.textContent = samples.length || guide ? "profile not built yet — tap rebuild" : "";
}

let voiceRebuildTimer = null;
function scheduleVoiceRebuild() {
  clearTimeout(voiceRebuildTimer);
  voiceRebuildTimer = setTimeout(async () => {
    $("voice-rebuild").textContent = "building…";
    await FA.voice.rebuild();
    $("voice-rebuild").textContent = "rebuild";
    renderVoice();
  }, 800);
}

async function addVoiceSample(title, text, source) {
  const s = await FA.voice.addSample({ title, text, source });
  if (!s) return false;
  scheduleVoiceRebuild();
  renderVoice();
  return true;
}

$("voice-paste").addEventListener("click", async () => {
  const ta = $("voice-textarea");
  if (ta.classList.contains("hidden")) {
    ta.classList.remove("hidden");
    ta.focus();
    $("voice-paste").textContent = "save";
    return;
  }
  const text = ta.value.trim();
  ta.value = "";
  ta.classList.add("hidden");
  $("voice-paste").textContent = "+ paste";
  if (!text) return;
  const ok = await addVoiceSample(text.split(/\n/)[0].slice(0, 60) || "pasted sample", text, "paste");
  if (!ok) $("voice-guide-note").textContent = "too short (need ~80+ words) or already added";
});
$("voice-file").addEventListener("click", () => $("voice-input").click());
$("voice-input").addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  for (const file of files) {
    try {
      let text;
      if (/pdf$/i.test(file.name) || file.type === "application/pdf") text = (await FA.pdfText.fromData(await file.arrayBuffer())).text;
      else text = typeof file.text === "function" ? await file.text() : await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsText(file); });
      await addVoiceSample(file.name.replace(/\.\w+$/, ""), text, "file");
    } catch (err) {
      $("voice-guide-note").textContent = `couldn't read ${file.name}: ${err.message}`;
    }
  }
});
$("voice-doc").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/docs\.google\.com\/document\/d\//.test(tab.url)) {
    $("voice-guide-note").textContent = "open one of your Google Docs in the active tab first";
    return;
  }
  try {
    const d = await FA.google.readDoc(tab.url);
    const ok = await addVoiceSample(d.title || tab.title?.replace(/ - Google Docs$/, "") || "doc", d.text, "gdoc");
    $("voice-guide-note").textContent = ok ? "added" : "too short or already added";
  } catch (e) {
    $("voice-guide-note").textContent = `couldn't read the doc: ${e.message}`;
  }
});
$("voice-drive").addEventListener("click", async () => {
  const box = $("voice-drive-list");
  if (!box.classList.contains("hidden")) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = '<div class="muted small">loading your recent docs…</div>';
  try {
    const docs = await FA.google.listRecentDocs(12);
    box.innerHTML = docs.length ? "" : '<div class="muted small">no Google Docs found for the connected account</div>';
    for (const d of docs) {
      const b = document.createElement("button");
      b.textContent = `📄 ${d.name}  · ${new Date(d.modifiedTime).toLocaleDateString()}`;
      b.addEventListener("click", async () => {
        b.textContent = `reading “${d.name}”…`;
        try {
          const doc = await FA.google.readDoc(d.id);
          const ok = await addVoiceSample(d.name, doc.text, "drive");
          b.textContent = ok ? `✓ added ${d.name}` : `${d.name} — too short / already added`;
        } catch (e) {
          b.textContent = `couldn't read ${d.name}: ${e.message}`;
        }
      });
      box.appendChild(b);
    }
  } catch (e) {
    box.innerHTML = `<div class="muted small">${escapeHtml(/no token|OAuth|not granted/i.test(e.message) ? "connect Google first (below)" : e.message)}</div>`;
  }
});
$("voice-import-guide").addEventListener("click", async () => {
  const note = $("voice-guide-note");
  note.textContent = "importing…";
  try {
    const res = await fetch(`${(await FA.bridgeConfig()).url}/voice/local`);
    const data = await res.json();
    let n = 0;
    if (data.guide) {
      await FA.voice.setGuide(data.guide, "~/.claude/skills/essay/SKILL.md");
      n++;
    }
    for (const s of data.samples || []) if (await FA.voice.addSample({ title: s.title, text: s.text, source: "file" })) n++;
    note.textContent = n ? `imported ${data.guide ? "the style guide" : ""}${data.samples?.length ? ` + ${data.samples.length} sample file(s)` : ""}` : "nothing found in ~/.claude/skills/essay";
    scheduleVoiceRebuild();
    renderVoice();
  } catch {
    note.textContent = "the bridge isn't running (python3 bridge/coach_server.py)";
  }
});
$("voice-auto-toggle").addEventListener("change", async (e) => {
  await FA.store.setSettings({ voiceAuto: e.target.checked });
  settings.voiceAuto = e.target.checked;
});
$("voice-rebuild").addEventListener("click", scheduleVoiceRebuild);

/**
 * Auto-learn: when an essay/project is finished and it has a doc the student
 * wrote themselves (no coach writing on record), it becomes a sample.
 */
async function autoLearnVoice(a) {
  if (!a || settings.voiceAuto === false) return;
  if (!["essay", "project", "other", "homework"].includes(a.type)) return;
  const meta = await FA.store.getMeta();
  const m = meta?.[a.id] || {};
  if (m.coachWrote) return; // the coach wrote into it — not the student's voice
  if (!m.docUrl && !m.docId) return;
  try {
    const d = await FA.google.readDoc(m.docId || m.docUrl);
    if (d.text.trim().split(/\s+/).length < 300) return;
    const ok = await FA.voice.addSample({ title: a.title, text: d.text, source: "auto" });
    if (ok) {
      scheduleVoiceRebuild();
      await pushCoach(`✨ Learned from “${a.title}” — it's now one of your writing samples (⚙ → your writing voice).`, { kind: "nudge" });
    }
  } catch {
    /* no access — fine */
  }
}

/** Which doc are we talking about? The assignment's, else the one in the active tab. */
async function docTarget(assignment) {
  const { id, url } = await docFor(assignment);
  if (id) return { id, url };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = tab?.url?.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
  if (m) {
    await FA.store.patchAssignmentMeta(assignment.id, { docUrl: tab.url.split("#")[0], docId: m[1] });
    return { id: m[1], url: tab.url };
  }
  return { id: null, url: null };
}

/** Formatting only — every build. Never changes the words. */
async function formatMyDoc() {
  const { id } = await docTarget(current.assignment);
  if (!id) return pushCoach("Open the Google Doc for this assignment in a tab (or start one with Smart Start) and tap format again.");
  if (!(await FA.google.isConnected().catch(() => false))) return pushCoach("Connect Google first (⚙ → connect G) — then I can format the doc.");
  showWorkTyping();
  try {
    const r = await FA.google.formatDoc(id, "mla");
    $("work-typing")?.remove();
    return pushCoach(r.applied ? `✨ formatted: Times New Roman 12, double-spaced, 1" margins, title centered, paragraphs indented — ${r.paragraphs} paragraphs, words untouched.` : "The doc is empty — nothing to format yet.", { kind: "nudge" });
  } catch (e) {
    $("work-typing")?.remove();
    return pushCoach(`Couldn't format the doc: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Ben's build — the coach does the work (developer mode only)
 * ------------------------------------------------------------------ */

/**
 * Dev autopilot: the coach does the assignment. Waits for the checklist
 * (brain version if it lands within a few seconds), makes sure there's a
 * doc when the work is written, then writes every unchecked step into it in
 * order, checking each off. Worksheet-style work with no doc → answerAll.
 * Stops if you switch assignments. Never finishes/submits by itself — that
 * stays behind auto-actions on done.
 */
let autopilotRunning = false;
async function runAutopilot(assignment) {
  if (autopilotRunning) return;
  autopilotRunning = true;
  const mine = () => current?.assignment.id === assignment.id;
  try {
    await pushCoach("🚀 autopilot: opening everything, then doing the steps. Sit back — I'll say when it's done.", { kind: "dev" });
    // Let the brain's checklist replace the rules one (it usually lands in <10s).
    for (let i = 0; i < 12 && mine() && current.steps.every((s) => s.source === "rules"); i++) await new Promise((r) => setTimeout(r, 1000));
    if (!mine()) return;

    const googleOn = await FA.google.isConnected().catch(() => false);
    let { id: docId } = await docFor(assignment);
    const written = ["essay", "project", "homework", "other", "lab", "reading"].includes(assignment.type);
    if (!docId && written && googleOn) {
      try {
        const { id, url } = await FA.google.createOutlineDoc(assignment.title, assignment.course, current.steps.map((s) => s.text));
        await FA.store.patchAssignmentMeta(assignment.id, { docUrl: url, docId: id });
        docId = id;
        await rememberTab(await chrome.tabs.create({ url, active: false }));
        await attachUrl(url, "your doc", { silent: true });
        await pushCoach("📄 made the doc with the outline in it.", { kind: "dev" });
      } catch (e) {
        await pushCoach(`couldn't create a doc (${e.message}) — writing in chat instead.`, { kind: "dev" });
      }
    }

    if (assignment.type === "test") {
      await makeStudyPlan();
      await makeFlashcards();
      await pushCoach("🚀 autopilot done: study plan + flashcards ready. Tests can't be done for you — quiz me when you want.", { kind: "dev" });
      return;
    }

    if (!docId && !googleOn && assignment.description && assignment.description.length > 40) {
      await devAnswerAll();
      await pushCoach("🚀 autopilot done: answers are above. Connect Google (⚙) and I'll put them straight into a doc next time.", { kind: "dev" });
      return;
    }

    let n = 0;
    for (const step of [...current.steps]) {
      if (!mine()) return;
      if (step.done) continue;
      await pushCoach(`✍️ step: ${step.text}`, { kind: "dev" });
      await devWriteStep(step);
      n++;
    }
    await pushCoach(`🚀 autopilot done: ${n} step${n === 1 ? "" : "s"} written${docId ? " into your doc" : ""}. Read it once, then done ✓${settings.autoDone ? " (auto-actions will tick myPoly + book the next block)" : ""}.`, { kind: "dev" });
  } finally {
    autopilotRunning = false;
  }
}

/** Dev: free-form edits to the doc, decided by the brain, applied in place. */
async function devEditDoc() {
  const instruction = window.prompt("What should the coach change in the doc?", "");
  if (!instruction) return;
  const { id } = await docTarget(current.assignment);
  if (!id) return pushCoach("No doc for this assignment — open it in a tab first.");
  showWorkTyping();
  try {
    const doc = await FA.google.getDoc(id);
    const r = await Promise.resolve(FA.coach.editDoc(current.assignment, FA.docOps.outline(doc), instruction));
    if (!r.ops?.length) {
      $("work-typing")?.remove();
      return pushCoach(r.error || "The coach had no edits for that.");
    }
    const applied = await FA.google.editDoc(id, r.ops);
    await FA.store.patchAssignmentMeta(current.assignment.id, { coachWrote: true });
    $("work-typing")?.remove();
    return pushCoach(`✍️ ${r.summary || "edited the doc"} (${applied.applied} change${applied.applied === 1 ? "" : "s"}).`, { kind: "dev" });
  } catch (e) {
    $("work-typing")?.remove();
    return pushCoach(`Couldn't edit the doc: ${e.message}`);
  }
}
async function docFor(assignment) {
  const meta = await FA.store.getMeta();
  const m = meta?.[assignment.id] || {};
  const id = m.docId || (m.docUrl?.match(/\/document\/d\/([\w-]+)/) || [])[1] || null;
  return { id, url: m.docUrl || null };
}

async function devWriteStep(step) {
  if (!step) return pushCoach("Every step is checked — nothing left to write.");
  showWorkTyping();
  const { id: docId } = await docFor(current.assignment);
  let docText = "";
  if (docId) {
    try {
      docText = (await FA.google.readDoc(`https://docs.google.com/document/d/${docId}/edit`)).text;
    } catch {
      /* fine — write without context */
    }
  }
  const r = await Promise.resolve(FA.coach.writeStep(current.assignment, step, current.steps, docText));
  $("work-typing")?.remove();
  if (!r.text) return pushCoach(r.error || "Couldn't write it.");

  if (docId && (await FA.google.isConnected().catch(() => false))) {
    try {
      const { words } = await FA.google.appendToDoc(docId, step.text, r.text);
      await FA.store.patchAssignmentMeta(current.assignment.id, { coachWrote: true });
      step.done = true;
      step.doneBy = "coach";
      step.doneAt = Date.now();
      renderSteps();
      await saveSteps();
      return pushCoach(`✍️ wrote “${step.text}” into your doc — ${words} words. Read it once before you keep it.`, { kind: "dev" });
    } catch (e) {
      await pushCoach(`Couldn't write into the doc (${e.message}) — here it is to paste:`, { kind: "dev" });
    }
  }
  return pushCoach(r.text, { kind: "dev" });
}

async function devAnswerAll() {
  showWorkTyping();
  const r = await Promise.resolve(FA.coach.answerAll(current.assignment));
  $("work-typing")?.remove();
  if (!r.text) return pushCoach(r.error || "Couldn't answer.");
  const { id: docId } = await docFor(current.assignment);
  if (docId && (await FA.google.isConnected().catch(() => false))) {
    try {
      await FA.google.appendToDoc(docId, "Answers", r.text);
      await FA.store.patchAssignmentMeta(current.assignment.id, { coachWrote: true });
      await pushCoach("✍️ answers written into your doc.", { kind: "dev" });
    } catch {
      /* fall through to chat */
    }
  }
  return pushCoach(r.text, { kind: "dev" });
}

/** Downscale a photo so the bridge (and the model) get a sane payload. */
function shrinkImage(file, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

$("photo-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file || !current) return;
  showWorkTyping();
  let dataUrl;
  try {
    dataUrl = await shrinkImage(file);
  } catch {
    $("work-typing")?.remove();
    return pushCoach("Couldn't read that image.");
  }
  const r = await Promise.resolve(FA.coach.readPhoto(current.assignment, current.steps, dataUrl));
  $("work-typing")?.remove();
  if (!r.legible) return pushCoach(`📷 ${r.feedback || "Too blurry to judge — try again with more light."}`, { kind: "dev" });
  for (const i of r.stepsDone) {
    const s = current.steps[i];
    if (s && !s.done) {
      s.done = true;
      s.doneBy = "photo";
      s.doneAt = Date.now();
    }
  }
  renderSteps();
  await saveSteps();
  const n = r.stepsDone.length;
  await pushCoach(`📷 ${n ? `checked ${n} step${n > 1 ? "s" : ""} from your photo. ` : "nothing on the list is visibly finished yet. "}${r.feedback}`, { kind: "dev" });
  if (current.steps.every((s) => s.done)) {
    await pushCoach("That's everything. Turned in?", { kind: "checkpoint", actions: [{ label: "finish ✓", cmd: "finish" }] });
  }
});

/** Tick the assignment complete in the portal (needs the captured request — see adapters/blackbaud.js). */
async function devMarkComplete(assignment) {
  const indexId = assignment.raw?.assignment_index_id ?? assignment.raw?.AssignmentIndexId ?? String(assignment.id).replace(/^blackbaud-/, "");
  const tabs = await chrome.tabs.query({ url: PORTAL_URL_PATTERNS });
  for (const tab of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "MARK_COMPLETE", indexId });
      if (res?.ok) return pushCoach("✓ ticked complete in myPoly.", { kind: "dev" });
      return pushCoach(`myPoly mark-complete: ${res?.error || "failed"}`, { kind: "dev" });
    } catch {
      /* next tab */
    }
  }
  return pushCoach("No portal tab open — open myPoly and try again.", { kind: "dev" });
}

/** Auto-actions after done ✓ (Ben's build, opt-in). Returns lines for the done view. */
async function autoActionsOnDone(a, nextPick) {
  const lines = [];
  if (!settings.devMode || !settings.autoDone || !a) return lines;
  try {
    const indexId = a.raw?.assignment_index_id ?? String(a.id).replace(/^blackbaud-/, "");
    const tabs = await chrome.tabs.query({ url: PORTAL_URL_PATTERNS });
    if (tabs[0]) {
      const res = await chrome.tabs.sendMessage(tabs[0].id, { type: "MARK_COMPLETE", indexId });
      lines.push(res?.ok ? "✓ ticked complete in myPoly" : `myPoly: ${res?.error || "not ticked"}`);
    }
  } catch {
    /* no portal tab */
  }
  if (nextPick && (await FA.google.isConnected().catch(() => false))) {
    try {
      const start = new Date(Date.now() + 10 * 60000);
      const end = new Date(start.getTime() + (nextPick.estMin || 25) * 60000);
      await FA.google.addEvent({ title: `📚 ${nextPick.title}`, description: nextPick.course, start, end, minutesBefore: 5 });
      lines.push(`📅 Calendar block for “${nextPick.title}” at ${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    } catch (e) {
      lines.push(`calendar: ${e.message}`);
    }
  }
  return lines;
}

/* ---- finishing ---- */
async function finishWork(done, extra = {}) {
  clearInterval(timerInterval);
  timerInterval = null;
  stopTimeUpCountdown();
  const a = current?.assignment;
  const stepsDone = current?.steps.filter((s) => s.done).length || 0;
  const stepsTotal = current?.steps.length || 0;

  const record = await FA.store.endSession(done ? "user" : extra.endedBy || "stop", { stepsDone, stepsTotal, ...(extra.endedAt ? { endedAt: extra.endedAt } : {}) });
  await chrome.storage.local.remove("pendingDone").catch(() => {});
  chrome.runtime.sendMessage({ type: "SESSION_ENDED" }).catch(() => {});

  if (done && a) {
    await FA.store.markDone(a.id);
    await FA.store.addQuestEvent(a, a.estMin);
    await autoLearnVoice(a);
    // Finished → the chat log for it is over. Steps and files stay for reference.
    await FA.store.patchAssignmentMeta(a.id, { thread: [] });
    if (current) current.thread = [];
  }
  await refreshAll();
  renderDone(a, record, done);
  showView("done");
}

/* ------------------------------------------------------------------ *
 * STATE C — done
 * ------------------------------------------------------------------ */
const DONE_LABELS = { user: "done ✓", portal: "myPoly says it's done ✓", steps: "every step checked ✓", doc: "doc finished ✓", stop: "stopped — logged", idle: "clock stopped — you went quiet" };

/**
 * Estimate calibration: how far this course's guesses run from reality, from
 * finished assignments (estMin vs minutes actually logged). The planning
 * fallacy in the interviews was ~5×; showing the number is the fix.
 */
function estimateCalibration(meta, course) {
  const ratios = Object.values(meta || {})
    .filter((m) => m?.done && m.estMin && m.spentMin >= 3 && (!course || m.course === course))
    .map((m) => m.spentMin / m.estMin)
    .sort((a, b) => a - b);
  if (ratios.length < 2) return null;
  const med = ratios[Math.floor(ratios.length / 2)];
  return { ratio: Math.round(med * 10) / 10, n: ratios.length };
}

async function renderDone(a, record, done) {
  $("done-label").textContent = DONE_LABELS[record?.endedBy] || (done ? "done ✓" : "stopped — logged");
  $("done-title").textContent = a?.title || "Focus session";
  const spent = record?.actualMin || 0;
  const guess = a?.estMin;
  const bits = [guess ? `${spent} min this sitting · you guessed ~${guess} min for the whole thing` : `${spent} min this sitting`];
  if (record?.idleMin) bits.push(`${record.idleMin} quiet min not counted`);
  if (done && a) {
    // Remember the guess with the assignment so calibration can use it later.
    await FA.store.patchAssignmentMeta(a.id, { estMin: a.estMin, course: a.course });
    const cal = estimateCalibration(await FA.store.getMeta(), a.course);
    if (cal && cal.ratio >= 1.3) bits.push(`your ${a.course} guesses run ${cal.ratio}× short (${cal.n} finished)`);
  }
  $("done-stats").textContent = bits.join(" · ");

  const deb = $("done-debrief");
  deb.textContent = "";
  if (record) {
    const sessions = await FA.store.getSessions();
    const weekAgo = Date.now() - 7 * 86400000;
    const week = sessions.filter((s) => s.endedAt > weekAgo);
    const weekStats = {
      sessions: week.length,
      totalMin: week.reduce((x, s) => x + s.actualMin, 0),
      avgDistractions: week.length ? Math.round((week.reduce((x, s) => x + (s.distractions || 0), 0) / week.length) * 10) / 10 : 0,
    };
    deb.textContent = new FA.MockCoach().debrief(record).line;
    if (FA.coachBrain === "claude") {
      Promise.resolve(FA.coach.debrief(record, weekStats)).then((d) => (deb.textContent = "🧠 " + d.line)).catch(() => {});
    }
  }

  // What's next: the coach's pick, minus what we just finished.
  const rest = ranked.filter((x) => x.id !== a?.id);
  const next = $("done-next");
  let nextPick = null;
  if (!rest.length) {
    next.classList.add("hidden");
  } else {
    const { assignment, reason } = new FA.MockCoach().pick(rest);
    nextPick = assignment;
    next.classList.remove("hidden");
    $("next-title").textContent = assignment.title;
    $("next-meta").textContent = `${assignment.course} · ~${assignment.estMin} min — ${reason}`;
    $("next-start").onclick = () => smartStart(assignment);
  }

  // Ben's build: auto-actions, reported honestly under the debrief.
  if (done) {
    const lines = await autoActionsOnDone(a, nextPick);
    if (lines.length) $("done-stats").textContent += "\n" + lines.join("\n");
  }
}

/* ------------------------------------------------------------------ *
 * ▸ MORE — classes, stats, XP, commitments, general chat, settings
 * ------------------------------------------------------------------ */
function gradeClass(g) {
  if (g == null) return "none";
  return g >= 90 ? "good" : g >= 80 ? "meh" : "bad";
}

function renderClasses() {
  const classList = $("class-list");
  const weekList = $("week-list");
  classList.innerHTML = "";
  weekList.innerHTML = "";

  if (!snapshot) {
    classList.innerHTML = '<div class="empty-note">No portal data yet. Open your school portal with the extension on, then hit ↻.</div>';
    return;
  }

  const academic = snapshot.classes.filter((c) => c.academic);
  for (const c of academic) {
    const gs = snapshot.grades[c.sectionId] || [];
    const trend = FA.gradeTrend(snapshot, c.sectionId, 3);
    const pendingHere = snapshot.assignments.filter((a) => a.sectionId === c.sectionId || a.course === c.course).length;
    const missing = gs.filter((g) => g.flags.missing).length;
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="class-row">
        <div><div class="card-title"></div><div class="card-meta"></div></div>
        <div class="class-grade ${gradeClass(c.grade)}"></div>
      </div>`;
    el.querySelector(".card-title").textContent = c.course;
    el.querySelector(".card-meta").textContent = [
      c.teacher,
      c.block ? `block ${c.block}` : "",
      `${pendingHere} pending`,
      missing ? `${missing} missing ⚠️` : "",
      trend.length ? "recent: " + trend.map((t) => `${Math.round(t.pct)}%`).join(" → ") : "",
    ].filter(Boolean).join(" · ");
    el.querySelector(".class-grade").textContent = c.grade != null ? `${Math.round(c.grade * 10) / 10}%` : "no grade yet";
    classList.appendChild(el);
  }
  if (!academic.length) classList.innerHTML = '<div class="empty-note">No classes found in the portal.</div>';

  const byDay = new Map();
  for (const s of snapshot.schedule) {
    if (!s.start) continue;
    const d = new Date(s.start);
    if (d < new Date(new Date().setHours(0, 0, 0, 0))) continue;
    const key = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(s);
  }
  for (const [day, items] of byDay) {
    const h = document.createElement("div");
    h.className = "week-day";
    h.textContent = day;
    weekList.appendChild(h);
    for (const s of items.sort((a, b) => (a.start > b.start ? 1 : -1))) {
      const row = document.createElement("div");
      row.className = "week-item";
      const t = s.allDay
        ? "all day"
        : `${new Date(s.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–${new Date(s.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      row.innerHTML = `<span class="t"></span><span class="n"></span>`;
      row.querySelector(".t").textContent = t;
      row.querySelector(".n").textContent = s.title + (s.room ? ` · ${s.room}` : "");
      weekList.appendChild(row);
    }
  }
  if (!byDay.size) weekList.innerHTML = '<div class="empty-note">Nothing on the schedule this week.</div>';

  // Phone notifications via the portal's own iCal feed (zero backend).
  const link = snapshot.icalLink;
  const gcal = $("phone-gcal");
  const copy = $("phone-copy");
  if (link) {
    $("phone-text").textContent =
      "Your portal publishes a private calendar feed. Subscribe once and every class and deadline shows up on your phone with reminders.";
    gcal.classList.remove("hidden");
    copy.classList.remove("hidden");
    const webcal = link.replace(/^https?:/, "webcal:");
    gcal.onclick = () => chrome.tabs.create({ url: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}` });
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = "Copied ✓";
        setTimeout(() => (copy.textContent = "Copy feed link"), 1500);
      } catch {
        copy.textContent = "Copy failed";
      }
    };
  } else {
    gcal.classList.add("hidden");
    copy.classList.add("hidden");
  }
}

function renderStats(sessions, commitments) {
  const weekAgo = Date.now() - 7 * 86400000;
  const thisWeek = sessions.filter((s) => s.endedAt > weekAgo);
  const weekMin = thisWeek.reduce((a, s) => a + s.actualMin, 0);

  $("stat-cards").innerHTML = "";
  const cards = [
    { value: FA.computeStreak(sessions), label: "day streak" },
    { value: Math.round(weekMin / 6) / 10, label: "hrs this week" },
    { value: sessions.length, label: "total sessions" },
  ];
  for (const c of cards) {
    const el = document.createElement("div");
    el.className = "stat-card";
    el.innerHTML = `<div class="stat-value">${c.value}</div><div class="stat-label">${c.label}</div>`;
    $("stat-cards").appendChild(el);
  }

  const autopsy = $("autopsy");
  const renderInsights = (lines, fromClaude) => {
    autopsy.innerHTML = "";
    for (const line of lines) {
      const el = document.createElement("div");
      el.className = "insight";
      el.textContent = (fromClaude ? "🧠 " : "") + line;
      autopsy.appendChild(el);
    }
  };
  renderInsights(new FA.MockCoach().autopsy(sessions, commitments), false);
  if (FA.coachBrain === "claude" && sessions.length >= 3) {
    Promise.resolve(FA.coach.autopsy(sessions, commitments)).then((lines) => renderInsights(lines, true)).catch(() => {});
  }

  $("chart-daily").innerHTML = FA.barChart(FA.minutesPerDay(sessions, 14), { unit: " min" });
  $("chart-hours").innerHTML = FA.barChart(FA.sessionsByHour(sessions), { unit: " min", color: "#6ee7a8" });
  const trend = FA.distractionTrend(sessions, 10);
  $("chart-distract-trend").innerHTML = trend.length >= 2
    ? FA.lineChart(trend, { color: "#fb7185" })
    : '<div class="empty-note small">Log a few sessions and this fills in.</div>';
  const sites = FA.distractionsBySite(sessions);
  if (sites.length) {
    $("chart-distract-sites").innerHTML = FA.hbarChart(sites, { unit: "×" });
    const worst = sites[0];
    const totalCost = sites.reduce((a, s) => a + s.costMin, 0);
    $("distract-cost").textContent = `${worst.label} is your #1 offender (${worst.value}×). Estimated total refocus cost: ~${totalCost} min.`;
  } else {
    $("chart-distract-sites").innerHTML = '<div class="empty-note small">No distractions logged yet.</div>';
    $("distract-cost").textContent = "";
  }
}

function renderLevel(sessions, questEvents) {
  const xp = FA.totalXp(sessions, questEvents);
  const { level, progress, needed } = FA.levelFor(xp);
  $("level-box").innerHTML = `
    <div class="level-title">Level ${level} · ${xp} XP</div>
    <div class="xp-bar"><div class="xp-fill" style="width:${Math.min((progress / needed) * 100, 100)}%"></div></div>
    <div class="xp-sub">${needed - progress} XP to level ${level + 1} — 1 focused minute = 1 XP</div>`;
}

async function addCommitment() {
  const text = $("commit-text").value.trim();
  const time = $("commit-time").value;
  if (!text || !time) return;
  const [hh, mm] = time.split(":").map(Number);
  const due = new Date();
  due.setHours(hh, mm, 0, 0);
  if (due < new Date()) due.setDate(due.getDate() + 1);
  await FA.store.addCommitment(text, due.getTime());
  $("commit-text").value = "";
  await refreshAll();
}

function renderCommitments(commitments) {
  const list = $("commit-list");
  list.innerHTML = "";
  const recent = commitments.slice(-6).reverse();
  if (!recent.length) {
    list.innerHTML = '<div class="empty-note small">No commitments yet. Say when — I\'ll remember.</div>';
    return;
  }
  for (const c of recent) {
    const el = document.createElement("div");
    el.className = "card commit-item";
    const status = c.keptAt
      ? '<span class="commit-status kept">✓ kept</span>'
      : c.missedAt
        ? '<span class="commit-status missed">✗ missed</span>'
        : `<span class="commit-status pending">⏳ ${new Date(c.dueAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>`;
    el.innerHTML = `<span class="c-text small"></span>${status}`;
    el.querySelector(".c-text").textContent = c.text;
    list.appendChild(el);
  }
}

/* ---- general chat (not tied to one assignment) ---- */
let chatHistory = [];

async function loadChat() {
  const obj = await chrome.storage.local.get("chatHistory");
  chatHistory = obj.chatHistory || [];
  renderChatMessages();
}

function renderChatMessages() {
  const wrap = $("chat-messages");
  wrap.innerHTML = "";
  if (!chatHistory.length) {
    wrap.innerHTML = '<div class="empty-note small">the coach knows your assignments, your pace and your week.</div>';
  }
  for (const m of chatHistory) {
    const el = document.createElement("div");
    el.className = "msg " + (m.role === "user" ? "me" : "coach");
    el.textContent = m.text;
    wrap.appendChild(el);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

async function sendChat(text) {
  const msg = (text ?? $("chat-input").value).trim();
  if (!msg) return;
  $("chat-input").value = "";
  chatHistory.push({ role: "user", text: msg, at: Date.now() });
  renderChatMessages();

  const wrap = $("chat-messages");
  const typing = document.createElement("div");
  typing.className = "msg coach";
  typing.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  wrap.appendChild(typing);

  const sessions = await FA.store.getSessions();
  const weekAgo = Date.now() - 7 * 86400000;
  const week = sessions.filter((s) => s.endedAt > weekAgo);
  const { doc, note } = await readOpenDoc();
  // The Google Doc in the active tab is the write target for the general chat (dev mode).
  let target = { id: null, url: null };
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const m = tab?.url?.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
    if (m) target = { id: m[1], url: tab.url.split("#")[0] };
  } catch {
    /* no tab access */
  }
  const googleConnected = await FA.google.isConnected().catch(() => false);
  const context = {
    ranked,
    brain: snapshot ? FA.snapshotForBrain(snapshot, { maxAssignments: 0 }) : null,
    mode: settings.mode || "tutor",
    devMode: Boolean(settings.devMode),
    googleConnected,
    docTarget: target.id ? target : null,
    doc,
    docNote: note,
    stats: {
      streak: FA.computeStreak(sessions),
      sessionsThisWeek: week.length,
      minutesThisWeek: week.reduce((a, s) => a + s.actualMin, 0),
    },
  };
  const { reply: raw } = await Promise.resolve(FA.coach.chat(chatHistory, context));
  typing.remove();
  const reply = await applyDocOpsFromReply(raw, target, googleConnected);
  chatHistory.push({ role: "coach", text: reply, at: Date.now() });
  chatHistory = chatHistory.slice(-40);
  await chrome.storage.local.set({ chatHistory });
  renderChatMessages();
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
$("more-btn").addEventListener("click", async () => {
  if (view === "more") {
    const s = await FA.store.getActiveSession();
    showView(s && current ? "work" : "list");
  } else showView("more");
});
$("refresh-btn").addEventListener("click", reloadFromPortal);
document.querySelectorAll(".time-chip").forEach((c) => c.addEventListener("click", () => setTimeBudget(Number(c.dataset.min))));

$("work-back").addEventListener("click", () => showView("list"));
$("work-done").addEventListener("click", () => finishWork(true));
$("work-stop").addEventListener("click", () => finishWork(false));
$("work-send").addEventListener("click", () => sendWork());
$("work-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendWork();
});
document.querySelectorAll("#work-chips .chat-chip").forEach((chip) => chip.addEventListener("click", () => runChip(chip.dataset.cmd)));
$("done-close").addEventListener("click", () => showView("list"));

// Mood check-in: dread gets a different response than fine.
document.querySelectorAll(".mood").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const mood = btn.dataset.mood;
    $("mood-row").classList.add("hidden");
    if (mood === "skip") {
      await FA.store.updateActiveSession({ moodSkipped: true });
      return;
    }
    await FA.store.updateActiveSession({ mood });
    const resp = $("mood-response");
    if (mood === "dread") {
      resp.textContent = "Dread means it feels too big — that's the dread talking, not the task. Do the first step and nothing else. The feeling changes after you start.";
      resp.classList.remove("hidden");
      setTimeout(() => resp.classList.add("hidden"), 15000);
    } else if (mood === "meh") {
      resp.textContent = "Fair. Autopilot is fine — the checklist does the caring for you.";
      resp.classList.remove("hidden");
      setTimeout(() => resp.classList.add("hidden"), 8000);
    }
  })
);

// ▸more wiring
$("mode-select").addEventListener("change", async (e) => {
  await FA.store.setSettings({ mode: e.target.value });
  settings.mode = e.target.value;
});
$("dev-toggle").addEventListener("change", async (e) => {
  await FA.store.setSettings({ devMode: e.target.checked });
  settings.devMode = e.target.checked;
  document.body.classList.toggle("dev", e.target.checked);
});
$("autopilot-toggle").addEventListener("change", async (e) => {
  await FA.store.setSettings({ autopilot: e.target.checked });
  settings.autopilot = e.target.checked;
});
$("nightly-toggle").addEventListener("change", async (e) => {
  await FA.store.setSettings({ nightlyPlan: e.target.checked });
  settings.nightlyPlan = e.target.checked;
  chrome.runtime.sendMessage({ type: "NIGHTLY_SYNC" }).catch(() => {});
});
$("auto-done-toggle").addEventListener("change", async (e) => {
  await FA.store.setSettings({ autoDone: e.target.checked });
  settings.autoDone = e.target.checked;
});
// Coach server + access code: save, then re-probe the bridge so the badge is honest.
for (const [id, key] of [["bridge-url", "bridgeUrl"], ["bridge-token", "bridgeToken"]]) {
  $(id).addEventListener("change", async (e) => {
    const value = e.target.value.trim();
    await FA.store.setSettings({ [key]: value });
    settings[key] = value;
    $("brain-badge").textContent = "🧠 checking…";
    await FA.initCoach();
    renderBrainBadge();
  });
}
$("commit-btn").addEventListener("click", addCommitment);
$("chat-send").addEventListener("click", () => sendChat());
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});
document.querySelectorAll("#view-chat .chat-chip[data-msg]").forEach((chip) => chip.addEventListener("click", () => sendChat(chip.dataset.msg)));
$("chat-clear").addEventListener("click", async () => {
  chatHistory = [];
  await chrome.storage.local.set({ chatHistory: [] });
  renderChatMessages();
});

// ✏️ draw on the current page (toggles; the annotator handles its own teardown).
$("annotate-btn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || tab.url?.startsWith("chrome://")) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["annotate/annotator.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["annotate/annotator.js"] });
  } catch (e) {
    console.warn("[Focus Agent] Can't annotate this page:", e.message);
  }
});

// G chip: connect / show Google status. Token lives in Chrome, not in us.
async function renderGoogleChip() {
  const acct = await FA.google.account().catch(() => null);
  const chip = $("google-btn");
  chip.textContent = acct ? "G ✓ connected" : "connect G";
  chip.title = acct ? "Google connected (Docs + Calendar). Click to disconnect." : "Connect Google (Docs + Calendar)";
  $("google-note").textContent = acct?.email ? acct.email : acct ? "Chrome account" : "";
}
$("google-btn").addEventListener("click", async () => {
  const chip = $("google-btn");
  if (await FA.google.isConnected()) {
    if (confirm("Disconnect Google from Focus Agent?")) await FA.google.disconnect();
  } else {
    chip.textContent = "G…";
    try {
      await FA.google.connect();
    } catch (e) {
      console.warn("[Focus Agent] Google connect failed:", e.message);
      const msg = /disabled for this account/i.test(e.message)
        ? "Your school account blocks this. Google's account picker should have opened so you can choose a personal Gmail — if it didn't, the web client isn't configured yet."
        : /not signed in/i.test(e.message)
        ? "Chrome itself isn't signed in to a Google account. Click your profile icon (top-right of Chrome) → sign in, then try again."
        : /bad client id|invalid_client|OAuth2 not granted|manifest/i.test(e.message)
          ? `Google rejected the client id (${e.message}). Try again shortly.`
          : `Google sign-in failed: ${e.message}`;
      sourceNotice = "⚠️ " + msg;
      $("forecast-headline").textContent = sourceNotice;
    }
  }
  renderGoogleChip();
});

// The selection toolbar (on pages) and the worker's detectors append to the
// assignment's thread; pick that up live instead of waiting for a re-open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.assignmentMeta && current) {
    const m = changes.assignmentMeta.newValue?.[current.assignment.id];
    const thread = Array.isArray(m?.thread) ? m.thread : null;
    if (thread && thread.length !== current.thread.length) {
      current.thread = thread;
      renderThread();
    }
  }
  if (changes.pendingDone?.newValue) showPendingDone(changes.pendingDone.newValue);
  // The worker flips idleAskAt / lastActiveAt; the ring should show it now.
  if (changes.activeSession && current && $("view-work").classList.contains("active")) {
    const was = changes.activeSession.oldValue;
    const now = changes.activeSession.newValue;
    if (Boolean(was?.idleAskAt) !== Boolean(now?.idleAskAt) || Boolean(was?.timeUpAt) !== Boolean(now?.timeUpAt) || Boolean(was) !== Boolean(now) || was?.plannedMin !== now?.plannedMin) restoreClock();
  }
});

// Any tap or keystroke in the panel = the student is here (throttled).
let lastActivityPing = 0;
for (const ev of ["click", "keydown"]) {
  document.addEventListener(
    ev,
    () => {
      if (Date.now() - lastActivityPing < 20000) return;
      lastActivityPing = Date.now();
      chrome.runtime.sendMessage({ type: "ACTIVITY" }).catch(() => {});
    },
    { passive: true }
  );
}

// The ring's start button (no clock running).
$("ring-start").addEventListener("click", async () => {
  if (!current) return;
  await startSession(current.assignment);
  await restoreClock();
});

/** The worker detected completion (portal flip) and closed the session. */
async function showPendingDone(pd) {
  if (!pd) return;
  clearInterval(timerInterval);
  timerInterval = null;
  await chrome.storage.local.remove("pendingDone");
  await refreshAll();
  const a = assignments.find((x) => x.id === pd.assignmentId) || { id: pd.assignmentId, title: pd.title, estMin: pd.record?.plannedMin };
  await renderDone(a, pd.record, true);
  showView("done");
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
/** The brain badge under ⚙: which coach is answering, and why if it isn't Claude. */
function renderBrainBadge() {
  const brain = FA.coachBrain;
  const h = FA.bridgeHealth || {};
  const stale = brain === "claude" && h.stale;
  const engine = h.engine === "api" ? "API" : "bridge";
  const badge = $("brain-badge");
  if (h.badToken) {
    badge.textContent = "🔒 wrong access code";
    badge.title = "The coach server answered but didn't accept the access code — check ⚙ → access code.";
    return;
  }
  badge.textContent = stale ? "🧠 bridge needs restart" : brain === "claude" ? `🧠 Claude (${engine}${h.hosted ? ", hosted" : ""})` : "⚙️ rules";
  badge.title = stale
    ? "The bridge's code changed since it was started — its prompts are out of date. Ctrl-C it and run: python3 bridge/coach_server.py"
    : brain === "claude"
      ? engine === "API"
        ? `Real Claude brain over the API (${h.model || "claude"})${h.hosted ? " on Ben's server" : ""}`
        : "Real Claude brain via headless Claude Code — slow. Put an API key in ~/.focus-agent/api_key and restart the bridge for the fast engine."
      : "Rule-based coach — no coach server reachable. ⚙ → coach server: paste the address + access code from Ben, or run python3 bridge/coach_server.py on this computer.";
}

(async () => {
  const brain = await FA.initCoach();
  const stale = brain === "claude" && FA.bridgeHealth?.stale;
  renderBrainBadge();
  if (stale) {
    sourceNotice = "⚠️ The coach bridge is running old code — restart it (Ctrl-C, then python3 bridge/coach_server.py) or new features won't reach the brain.";
    $("forecast-headline").textContent = sourceNotice;
  }

  await loadAssignments();
  await refreshAll();
  await loadChat();
  renderGoogleChip();
  renderVoice();

  // The popup asked us to Smart Start something specific.
  const { panelStart, panelOpenTab } = await chrome.storage.local.get(["panelStart", "panelOpenTab"]);
  if (panelStart) {
    await chrome.storage.local.remove("panelStart");
    const a = ranked.find((x) => x.id === panelStart);
    if (a) return smartStart(a);
  }
  if (panelOpenTab) {
    await chrome.storage.local.remove("panelOpenTab");
    if (panelOpenTab === "more") showView("more");
  }

  // The worker finished a session while the panel was closed.
  const { pendingDone } = await chrome.storage.local.get("pendingDone");
  if (pendingDone) return showPendingDone(pendingDone);

  // A session is already running → land in the work view.
  const s = await FA.store.getActiveSession();
  if (s) {
    const a = ranked.find((x) => x.id === s.assignmentId) || assignments.find((x) => x.id === s.assignmentId);
    await enterWork(a || { id: s.assignmentId, title: s.title, course: s.course, estMin: s.plannedMin });
  }
})();
