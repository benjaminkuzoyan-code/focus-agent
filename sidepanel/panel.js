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
let assignments = [];   // normalized, from mock adapter / portal / cache
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

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */
function showView(name) {
  view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".dock .tab").forEach((b) => b.classList.toggle("active", b.dataset.view === name || (name === "work" && b.dataset.view === "list") || (name === "done" && b.dataset.view === "list")));
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
  if (/docs\.google\.com\/document/.test(tab.url)) return flash("📄");
  if (/\.pdf($|[?#])/i.test(new URL(tab.url).pathname) || tab.url.startsWith("file:")) {
    if (!tab.url.includes("/viewer/pdfjs/")) {
      await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL("viewer/pdfjs/web/viewer.html") + "?file=" + encodeURIComponent(tab.url) });
      return flash("↻");
    }
  }
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
    console.warn("[Focus Agent] can't highlight here:", e.message);
    flash("✕");
  }
});

/* ------------------------------------------------------------------ *
 * Data loading
 * ------------------------------------------------------------------ */

/** Load assignments per the chosen source: mock, or live portal tab, or cache. */
async function loadAssignments(retried = false) {
  settings = await FA.store.getSettings();
  $("source-select").value = settings.dataSource;
  $("mode-select").value = settings.mode || "tutor";
  $("dev-toggle").checked = Boolean(settings.devMode);
  $("nightly-toggle").checked = Boolean(settings.nightlyPlan);
  $("auto-done-toggle").checked = Boolean(settings.autoDone);
  document.body.classList.toggle("dev", Boolean(settings.devMode));

  sourceNotice = "";
  if (settings.dataSource === "mock") {
    assignments = await FA.adapters.mock.fetchAssignments();
    return;
  }

  // "auto": find an open portal tab and ask its content script.
  const tabs = await chrome.tabs.query({ url: PORTAL_URL_PATTERNS });

  // Every step is recorded so a failure explains itself in the headline
  // instead of silently showing demo data.
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
    assignments = await FA.adapters.mock.fetchAssignments();
    sourceNotice = `⚠️ Demo data — ${why}. Open your school portal, refresh it, then hit ↻.`;
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
  if (/myschoolapp\.com|blackbaud\.com|instructure\.com|classroom\.google\.com/.test(tab.url)) {
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
    list.innerHTML = '<div class="empty-note">Nothing pending. 🏖️</div>';
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

/** Open a URL in a tab; PDFs go through our pdf.js viewer so highlighting works. */
async function openTab(url, active) {
  let target = url;
  try {
    const u = new URL(url);
    if (/\.pdf($|[?#])/i.test(u.pathname + u.search) && !u.href.startsWith(chrome.runtime.getURL(""))) {
      target = chrome.runtime.getURL("viewer/pdfjs/web/viewer.html") + "?file=" + encodeURIComponent(url);
    }
  } catch {
    /* not a URL we can parse — open as-is */
  }
  return chrome.tabs.create({ url: target, active });
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
  const plan = meta?.[assignment.id]?.setupPlan || new FA.MockCoach().setup(assignment, resources);

  await permission; // resolved or denied — either way we go on
  if (assignment.url) await rememberTab(await openTab(assignment.url, true));
  let opened = [];
  try {
    opened = await executeSetupPlan(assignment, plan, resources);
  } catch (e) {
    console.warn("[Focus Agent] setup execution failed (non-fatal):", e.message);
  }

  // 4. The coach speaks first: the setup summary, then a question if it
  //    isn't sure what the assignment wants.
  await pushCoach(setupMessage(plan, opened), { kind: "setup" });
  if (!settings.hintedHighlight) {
    await FA.store.setSettings({ hintedHighlight: true });
    settings.hintedHighlight = true;
    await pushCoach("Tip: on the pages I opened, select any text → 🖍 annotate · ≡ summarize · ? ask pop up above it. Other page? Tap 🖍 in the header first. (Google Docs can't be highlighted — use check my draft.)", { kind: "nudge" });
  }
  if ((plan.confidence ?? 1) < 0.6 && plan.missing?.length) {
    await pushCoach(`Before we go — ${plan.missing[0]}?`, { kind: "question" });
  }

  // 5. Brain upgrade in the background: better plan + suggested extras as
  //    click-to-open lines, never surprise tabs mid-session.
  if (FA.coachBrain === "claude" && !plan.fromClaude) {
    Promise.resolve(FA.coach.setup(assignment, resources))
      .then(async (brainPlan) => {
        if (!brainPlan.fromClaude || current?.assignment.id !== assignment.id) return;
        await FA.store.patchAssignmentMeta(assignment.id, { setupPlan: brainPlan });
        const alreadyOpened = new Set((plan.opens || []).map((o) => `${o.kind}:${o.i}`));
        const extras = (brainPlan.opens || [])
          .filter((o) => !alreadyOpened.has(`${o.kind}:${o.i}`))
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
    awaitingDraft: false,
  };

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

async function restoreClock() {
  clearInterval(timerInterval);
  const session = await FA.store.getActiveSession();
  const moodRow = $("mood-row");
  if (!session) {
    $("work-elapsed").textContent = "—";
    $("work-chunk").textContent = "no clock running";
    $("chunk-fill").style.width = "0%";
    moodRow.classList.add("hidden");
    return;
  }
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
    $("chunk-fill").style.width = pct.toFixed(1) + "%";
    $("chunk-fill").classList.toggle("over", elapsed > chunk);
    $("work-chunk").textContent =
      session.mode === "paper"
        ? "paper mode — check-ins by notification"
        : elapsed <= chunk
          ? `${Math.ceil((chunk - elapsed) / 60)} min left in this chunk`
          : `past the ${session.plannedMin}-min chunk — finish the thought`;
    // Chunk boundary → one checkpoint in the thread (per chunk length).
    if (elapsed >= chunk && !checkpointFired && session.checkpointFor !== session.plannedMin) {
      checkpointFired = true;
      onChunkBoundary(session);
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
      await FA.store.updateActiveSession({ plannedMin: m, checkpointFor: null });
      chrome.runtime.sendMessage({ type: "SESSION_STARTED", checkinMin: m }).catch(() => {});
      await restoreClock();
    });
    wrap.appendChild(b);
  }
  $("chunk-why").textContent = session.chunkWhy || "";
}

/**
 * The visible checkpoint S04 asked for: at the end of a chunk the coach says
 * what got done and offers the next move. First boundary also decides paper
 * mode (no doc, no tab activity → the work is off-screen).
 */
async function onChunkBoundary(session) {
  await FA.store.updateActiveSession({ checkpointFor: session.plannedMin });
  const cur = current?.steps.find((s) => !s.done);
  const done = current?.steps.filter((s) => s.done).length || 0;
  const total = current?.steps.length || 0;

  if (session.mode !== "paper" && !session.paperChecked) {
    const meta = await FA.store.getMeta();
    const hasDoc = Boolean(meta?.[session.assignmentId]?.docUrl);
    await FA.store.updateActiveSession({ paperChecked: true });
    if (!hasDoc && (session.activityCount || 0) === 0) {
      await FA.store.updateActiveSession({ mode: "paper" });
      await pushCoach("Looks like this one's on paper — I'll keep the clock and check in by notification. Tap done ✓ when it's finished, or mark it complete in myPoly and I'll notice.", { kind: "paper" });
      await restoreClock();
      return;
    }
  }

  const head = `${session.plannedMin} min in — ${total ? `${done}/${total} steps` : "checkpoint"}.`;
  const body = cur ? `Is “${cur.text}” done?` : "Everything on the list is checked. Turned in?";
  await pushCoach(`${head} ${body}`, {
    kind: "checkpoint",
    actions: cur
      ? [{ label: "step done ✓", cmd: "step-done" }, { label: "+5 more", cmd: "more5" }, { label: "finish ✓", cmd: "finish" }]
      : [{ label: "finish ✓", cmd: "finish" }, { label: "+5 more", cmd: "more5" }],
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

  const context = {
    ranked,
    brain: snapshot ? FA.snapshotForBrain(snapshot, { maxAssignments: 0 }) : null,
    mode: settings.mode || "tutor",
    doc,
    docNote: note,
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
  await pushCoach(reply);
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
    case "more5": {
      const s = await FA.store.getActiveSession();
      if (!s) return startSession(current.assignment, 5).then(restoreClock);
      await FA.store.updateActiveSession({ plannedMin: (s.plannedMin || 0) + 5 });
      await restoreClock();
      return pushCoach("+5. Same step, no new tabs.", { kind: "nudge" });
    }
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
    case "dev-edit":
      return devEditDoc();
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
async function finishWork(done) {
  clearInterval(timerInterval);
  timerInterval = null;
  const a = current?.assignment;
  const stepsDone = current?.steps.filter((s) => s.done).length || 0;
  const stepsTotal = current?.steps.length || 0;

  const record = await FA.store.endSession(done ? "user" : "stop", { stepsDone, stepsTotal });
  await chrome.storage.local.remove("pendingDone").catch(() => {});
  chrome.runtime.sendMessage({ type: "SESSION_ENDED" }).catch(() => {});

  if (done && a) {
    await FA.store.markDone(a.id);
    await FA.store.addQuestEvent(a, a.estMin);
  }
  await refreshAll();
  renderDone(a, record, done);
  showView("done");
}

/* ------------------------------------------------------------------ *
 * STATE C — done
 * ------------------------------------------------------------------ */
const DONE_LABELS = { user: "done ✓", portal: "myPoly says it's done ✓", steps: "every step checked ✓", doc: "doc finished ✓", stop: "stopped — logged" };

async function renderDone(a, record, done) {
  $("done-label").textContent = DONE_LABELS[record?.endedBy] || (done ? "done ✓" : "stopped — logged");
  $("done-title").textContent = a?.title || "Focus session";
  const spent = record?.actualMin || 0;
  const guess = a?.estMin;
  $("done-stats").textContent = guess
    ? `${spent} min this sitting · you guessed ~${guess} min for the whole thing`
    : `${spent} min this sitting`;

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
  const context = {
    ranked,
    brain: snapshot ? FA.snapshotForBrain(snapshot, { maxAssignments: 0 }) : null,
    mode: settings.mode || "tutor",
    doc,
    docNote: note,
    stats: {
      streak: FA.computeStreak(sessions),
      sessionsThisWeek: week.length,
      minutesThisWeek: week.reduce((a, s) => a + s.actualMin, 0),
    },
  };
  const { reply } = await Promise.resolve(FA.coach.chat(chatHistory, context));
  typing.remove();
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
$("source-select").addEventListener("change", async (e) => {
  await FA.store.setSettings({ dataSource: e.target.value });
  await loadAssignments();
  await refreshAll();
});
$("dev-toggle").addEventListener("change", async (e) => {
  await FA.store.setSettings({ devMode: e.target.checked });
  settings.devMode = e.target.checked;
  document.body.classList.toggle("dev", e.target.checked);
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
$("commit-btn").addEventListener("click", addCommitment);
$("chat-send").addEventListener("click", () => sendChat());
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});
document.querySelectorAll("#view-more .chat-chip").forEach((chip) => chip.addEventListener("click", () => sendChat(chip.dataset.msg)));

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
(async () => {
  const brain = await FA.initCoach();
  $("brain-badge").textContent = brain === "claude" ? "🧠 Claude (bridge)" : "⚙️ rules";
  $("brain-badge").title =
    brain === "claude"
      ? "Real Claude brain (local bridge running)"
      : "Rule-based coach — start the bridge for the real brain: python3 bridge/coach_server.py";

  await loadAssignments();
  await refreshAll();
  await loadChat();
  renderGoogleChip();

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
