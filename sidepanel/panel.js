/**
 * sidepanel/panel.js - The coach's main surface.
 *
 * Tabs: Today (ranked list + coach pick + Smart Start), Panic (triage),
 * Timer (sessions + commitments), Stats (streak + autopsy), Quests (XP +
 * boss battles). All data flows through FA.* libs; the AI brain is
 * FA.coach (MockCoach now, ClaudeCoach later — zero changes here).
 */

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
let assignments = [];   // normalized, from mock adapter / portal / cache
let ranked = [];        // assignments + estMin + urgency, sorted
let sourceNotice = "";  // why we're NOT showing live portal data ("" when live)
let snapshot = null;    // full Student Snapshot (classes, grades, schedule) — see lib/snapshot.js
let timerInterval = null;

const $ = (id) => document.getElementById(id);

/** Escape brain-generated text before any innerHTML use. */
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DISTRACTOR_PATTERNS = [
  /youtube\.com/, /tiktok\.com/, /instagram\.com/, /twitter\.com/, /x\.com/,
  /reddit\.com/, /netflix\.com/, /twitch\.tv/, /discord\.com/, /pinterest\.com/,
];

/* ------------------------------------------------------------------ *
 * Data loading
 * ------------------------------------------------------------------ */

/** Load assignments per the chosen source: mock, or live portal tab, or cache. */
async function loadAssignments(retried = false) {
  const settings = await FA.store.getSettings();
  $("source-select").value = settings.dataSource;
  $("mode-select").value = settings.mode || "tutor";

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
        // The full snapshot (grades, schedule, topics) rides along; the
        // content script caches it, so a miss here just means "use cached".
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
      // extension loaded/reloaded, so it has no content script. A page
      // refresh fixes it.
      disconnected++;
      diag.push(`${label}: not connected`);
    }
  }

  // Tabs without a content script = the extension was reloaded. Ask the
  // worker to re-inject, then try once more before falling back.
  if (disconnected && !retried) {
    try {
      const r = await chrome.runtime.sendMessage({ type: "REINJECT" });
      if (r?.tabs) {
        await new Promise((res) => setTimeout(res, 1500));
        return loadAssignments(true);
      }
    } catch {
      /* worker asleep or old worker without REINJECT — fall through */
    }
  }

  // No live portal — fall back to the last cached fetch, then to mock.
  snapshot = await FA.loadSnapshot();
  const cache = await FA.store.getCachedAssignments();
  // Keep the headline readable: one line, not one per tab.
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

const PORTAL_URL_PATTERNS = [
  "https://*.myschoolapp.com/*",
  "https://*.blackbaud.com/*",
  "https://*.instructure.com/*",
  "https://classroom.google.com/*",
];

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
  // trackSeen stamps first-visibility on every assignment (avoidance clock)
  // and hands back the merged meta in one storage round-trip.
  const [meta, sessions, questEvents, commitments] = await Promise.all([
    FA.store.trackSeen(assignments),
    FA.store.getSessions(),
    FA.store.getQuestEvents(),
    FA.store.getCommitments(),
  ]);

  ranked = FA.rankAssignments(assignments, meta, sessions);

  renderStreak(sessions);
  renderForecast(meta, sessions);
  renderToday(sessions, meta);
  renderAvoidance(meta, sessions);
  renderStats(sessions, commitments);
  renderQuests(meta, sessions, questEvents);
  renderCommitments(commitments);
  renderClasses();
  await restoreTimerIfActive();
}

/* ------------------------------------------------------------------ *
 * Classes tab: grades, this week's schedule, phone notifications.
 * Everything here comes from the Student Snapshot; nothing is computed
 * by the brain, so it's instant and works offline.
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
    classList.innerHTML =
      '<div class="empty-note">No portal data yet. Open your school portal with the extension on, then hit ↻.</div>';
    return;
  }

  // --- classes + grades ---
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
        <div>
          <div class="card-title"></div>
          <div class="card-meta"></div>
        </div>
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
    el.querySelector(".class-grade").textContent =
      c.grade != null ? `${Math.round(c.grade * 10) / 10}%` : "no grade yet";
    classList.appendChild(el);
  }
  if (!academic.length) classList.innerHTML = '<div class="empty-note">No classes found in the portal.</div>';

  // --- this week's schedule, grouped by day ---
  const byDay = new Map();
  for (const s of snapshot.schedule) {
    if (!s.start) continue;
    const d = new Date(s.start);
    if (d < new Date(new Date().setHours(0, 0, 0, 0))) continue; // past days
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

  // --- phone notifications via the portal's own iCal feed ---
  // Zero backend: Google/Apple Calendar subscribe to the feed and push
  // reminders to the phone. The link is a private token — never displayed.
  const link = snapshot.icalLink;
  const gcal = $("phone-gcal");
  const copy = $("phone-copy");
  if (link) {
    $("phone-text").textContent =
      "Your portal publishes a private calendar feed. Subscribe once and every class and deadline shows up on your phone with reminders.";
    gcal.classList.remove("hidden");
    copy.classList.remove("hidden");
    const webcal = link.replace(/^https?:/, "webcal:");
    gcal.onclick = () =>
      chrome.tabs.create({ url: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}` });
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

/* ------------------------------------------------------------------ *
 * Avoidance detection — a friend noticing, never a guilt trip.
 * ------------------------------------------------------------------ */
function renderAvoidance(meta, sessions) {
  const card = $("avoid-card");
  const avoided = FA.findAvoided(ranked, meta, sessions);
  if (!avoided.length) {
    card.classList.add("hidden");
    return;
  }

  // One card, highest-urgency avoided item only — a list would be a wall of shame.
  const { assignment, daysVisible, overdue } = avoided[0];
  card.classList.remove("hidden");
  $("avoid-text").textContent = overdue
    ? `"${assignment.title}" slipped past its due date without a single session. That usually means it feels too big — not that you don't care. Smallest possible start?`
    : `"${assignment.title}" has been sitting there ${daysVisible} day${daysVisible > 1 ? "s" : ""} and you haven't touched it. Usually that means it feels too big. Let's shrink it.`;

  $("avoid-micro").onclick = async () => {
    // 2-minute micro-start: make beginning nearly free — the research says
    // the emotion changes after you start, so the job is just to start.
    await smartStart(assignment, 2);
  };
  $("avoid-breakdown").onclick = () => {
    switchTab("today");
    const target = document.querySelector(`#today-list .card .plan-btn`);
    // Find this assignment's card and open its breakdown.
    for (const c of document.querySelectorAll("#today-list .card")) {
      if (c.querySelector(".card-title")?.textContent === assignment.title) {
        c.querySelector(".plan-btn")?.click();
        c.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
    target?.click();
  };
}

/* ------------------------------------------------------------------ *
 * Renderers
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
  // The source notice wins over the forecast line: "why am I seeing fake
  // data" matters more than the weather when something's wrong.
  $("forecast-headline").textContent = sourceNotice || headline;
}

function dueLabel(a) {
  if (!a.dueDate) return "no due date";
  const h = FA.hoursUntil(a.dueDate);
  if (h < 0) return "OVERDUE";
  if (h < 24) return "due today/tomorrow";
  return `due ${new Date(a.dueDate).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
}

/* ------------------------------------------------------------------ *
 * Doc Starter: create the doc with structure ready to paste.
 * Google Docs renders in canvas, so we can't type into it directly
 * without OAuth (later upgrade). Instead: create the titled doc, put the
 * coach's outline on the clipboard, and it's one Cmd+V from structured.
 * ------------------------------------------------------------------ */
async function startDoc(assignment, meta) {
  const existing = meta?.[assignment.id]?.docUrl;
  if (existing) {
    await chrome.tabs.create({ url: existing, active: true });
    return;
  }

  // Outline skeleton from the coach's breakdown.
  const steps = FA.coach.breakdown(assignment);
  const skeleton = [
    assignment.title,
    `${assignment.course} — due ${assignment.dueDate ? new Date(assignment.dueDate).toLocaleDateString() : "?"}`,
    "",
    ...steps.map((s, i) => `${i + 1}. ${s}\n\n`),
  ].join("\n");

  // With Google connected: create the doc with the outline already in it,
  // styled (title/subtitle/numbered steps). No clipboard dance.
  if (await FA.google.isConnected()) {
    try {
      const subtitle = `${assignment.course} — due ${assignment.dueDate ? new Date(assignment.dueDate).toLocaleDateString() : "?"}`;
      const { id, url } = await FA.google.createOutlineDoc(assignment.title, subtitle, steps);
      await FA.store.patchAssignmentMeta(assignment.id, { docUrl: url, docId: id });
      await chrome.tabs.create({ url, active: true });
      return;
    } catch (e) {
      console.warn("[Focus Agent] Docs API create failed, falling back to clipboard:", e.message);
    }
  }

  try {
    await navigator.clipboard.writeText(skeleton);
  } catch {
    /* clipboard can fail without focus; the doc still opens */
  }

  const url = `https://docs.google.com/document/create?title=${encodeURIComponent(assignment.title)}`;
  const tab = await chrome.tabs.create({ url, active: true });

  // The create URL redirects to the real /document/d/<id>/ URL — poll
  // briefly so next time the button reopens the same doc.
  let tries = 0;
  const poll = setInterval(async () => {
    tries++;
    try {
      const t = await chrome.tabs.get(tab.id);
      const m = t.url?.match(/docs\.google\.com\/document\/d\/[\w-]+/);
      if (m) {
        clearInterval(poll);
        await FA.store.patchAssignmentMeta(assignment.id, { docUrl: "https://" + m[0] + "/edit" });
      }
    } catch {
      clearInterval(poll); // tab closed
    }
    if (tries > 20) clearInterval(poll);
  }, 700);
}

/** Remove any open sub-panel of the given class on a card; true if one was open. */
function closeBox(card, cls) {
  const existing = card.querySelector("." + cls);
  if (existing) {
    existing.remove();
    return true;
  }
  return false;
}

/** 💡 Explain: the assignment in plain language — what's wanted, traps, first move. */
async function toggleExplain(card, a) {
  if (closeBox(card, "explain-box")) return;
  closeBox(card, "precheck-box");
  const box = document.createElement("div");
  box.className = "explain-box";
  box.textContent = FA.coachBrain === "claude" ? "🧠 reading the assignment…" : "";
  card.appendChild(box);

  const brainCtx = snapshot ? FA.snapshotForBrain(snapshot, { maxAssignments: 0 }) : null;
  const r = await Promise.resolve(FA.coach.explain(a, brainCtx));
  const li = (arr) => arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
  box.innerHTML = `
    <div class="tldr">${r.fromClaude ? "🧠 " : ""}${escapeHtml(r.tldr)}</div>
    ${r.wants.length ? `<div class="muted small">what the teacher wants</div><ul>${li(r.wants)}</ul>` : ""}
    ${r.traps.length ? `<div class="muted small">traps</div><ul>${li(r.traps)}</ul>` : ""}
    <div class="first">▶ first move (~5 min): ${escapeHtml(r.firstMove)}<br><span class="muted small">whole thing: ~${r.estMinutes} min</span></div>`;
}

/**
 * 🔍 Pre-check: tutor feedback on a draft — pointers and questions, never rewrites.
 * Two ways in: paste text, or give a Google Docs link (reads it via the Docs
 * API once Google is connected). With a doc, feedback can be posted back as
 * COMMENTS anchored to the quoted sentences — the "annotate homework" feature.
 */
function togglePrecheck(card, a) {
  if (closeBox(card, "precheck-box")) return;
  closeBox(card, "explain-box");
  const box = document.createElement("div");
  box.className = "precheck-box";
  box.innerHTML = `
    <div class="muted small">Paste your draft, or drop a Google Docs link. The coach checks it against the assignment and points at what to fix — it won't rewrite it for you.</div>
    <input type="text" class="doc-link" placeholder="https://docs.google.com/document/d/…  (optional)" />
    <textarea placeholder="…or paste your draft here"></textarea>
    <div class="card-actions"><button class="start run-precheck">Check it</button></div>
    <div class="result"></div>`;
  card.appendChild(box);
  const ta = box.querySelector("textarea");
  const linkInput = box.querySelector(".doc-link");
  const meta = { docId: null };
  // Remember the doc this assignment lives in, so the link is prefilled next time.
  FA.store.getMeta().then((m) => {
    const url = m?.[a.id]?.docUrl;
    if (url) linkInput.value = url;
  });
  (linkInput.value ? linkInput : ta).focus();

  box.querySelector(".run-precheck").addEventListener("click", async () => {
    const out = box.querySelector(".result");
    let draft = ta.value.trim();
    const link = linkInput.value.trim();

    if (link) {
      out.textContent = "📄 reading your doc…";
      try {
        const doc = await FA.google.readDoc(link);
        draft = doc.text.trim();
        meta.docId = doc.id;
        ta.value = draft;
        await FA.store.patchAssignmentMeta(a.id, { docUrl: `https://docs.google.com/document/d/${doc.id}/edit` });
      } catch (e) {
        out.textContent = /no token|OAuth2|not granted|canceled|disabled/i.test(e.message)
          ? "Couldn't read it with your browser login, and Google isn't connected. Make sure you can open the doc in this Chrome profile."
          : `Couldn't read that doc: ${e.message}`;
        return;
      }
    }
    if (draft.length < 20) {
      out.textContent = "Paste a bit more than that (or check the doc link).";
      return;
    }

    out.textContent = FA.coachBrain === "claude" ? "🧠 reading your draft… (10–20s)" : "";
    const r = await Promise.resolve(FA.coach.precheck(a, draft));
    const li = (arr) => arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
    out.innerHTML = `
      <div style="margin:8px 0 4px"><span class="grade-pill">${escapeHtml(r.grade)}</span>${r.fromClaude ? "🧠 honest estimate — not your teacher's grade" : "rules only — start the bridge for a real read"}</div>
      ${r.strengths.length ? `<div class="muted small">what's working</div><ul>${li(r.strengths)}</ul>` : ""}
      ${r.issues.map((i) => `<div class="issue">${i.quote ? `<q>${escapeHtml(i.quote)}</q><br>` : ""}${escapeHtml(i.problem)}<br><b>→ ${escapeHtml(i.hint)}</b></div>`).join("")}
      ${r.missing.length ? `<div class="muted small">not addressed yet</div><ul>${li(r.missing)}</ul>` : ""}
      <div class="first" style="margin-top:6px">▶ ${escapeHtml(r.nextStep)}</div>
      ${meta.docId && r.fromClaude ? '<div class="card-actions"><button class="post-comments">💬 Post as comments on the doc</button></div>' : ""}`;

    out.querySelector(".post-comments")?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = "posting…";
      try {
        const n = await FA.google.postPrecheckComments(meta.docId, r);
        btn.textContent = `✓ ${n} comments added — open the doc`;
        btn.disabled = false;
        btn.onclick = () => chrome.tabs.create({ url: `https://docs.google.com/document/d/${meta.docId}/edit` });
      } catch (e) {
        btn.textContent = `couldn't post: ${e.message}`;
      }
    });
  });
}

function renderToday(sessions, meta = {}) {
  // Instant pick from the rules, upgraded in place by the real brain when
  // the bridge is up — the UI never waits on a 15s Claude call.
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
    list.innerHTML = '<div class="empty-note">Nothing pending.</div>';
    return;
  }

  for (const a of ranked) {
    const h = FA.hoursUntil(a.dueDate);
    const card = document.createElement("div");
    card.className = "card" + (h < 0 ? " overdue" : h < 30 ? " due-soon" : "");
    const wantsDoc = a.type === "essay" || a.type === "project";
    card.innerHTML = `
      <div class="card-title"></div>
      <div class="card-meta"></div>
      <div class="card-actions">
        <button class="start">▶ Smart Start</button>
        ${wantsDoc ? '<button class="doc-btn"></button>' : ""}
        <button class="plan-btn">Break it down</button>
        <button class="explain-btn" title="What is the teacher actually asking for?">💡 Explain</button>
        <button class="precheck-btn" title="Paste your draft — get tutor feedback before you turn it in">🔍 Pre-check</button>
        <button class="done-btn">✓ Done</button>
      </div>`;
    card.querySelector(".card-title").textContent = a.title;
    card.querySelector(".card-meta").textContent =
      `${a.course} · ${dueLabel(a)} · ~${a.estMin} min` + (a.points ? ` · ${a.points} pts` : "");

    card.querySelector(".start").addEventListener("click", () => smartStart(a));
    if (wantsDoc) {
      const docBtn = card.querySelector(".doc-btn");
      docBtn.textContent = meta?.[a.id]?.docUrl ? "📄 Open your doc" : "📄 Start the doc";
      docBtn.title = meta?.[a.id]?.docUrl
        ? "Reopen the doc you started for this"
        : "Creates a titled Google Doc + copies the outline — just paste";
      docBtn.addEventListener("click", () => startDoc(a, meta));
    }
    card.querySelector(".done-btn").addEventListener("click", async () => {
      await FA.store.markDone(a.id);
      await FA.store.addQuestEvent(a, a.estMin); // quest complete = bonus XP
      await refreshAll();
    });
    card.querySelector(".plan-btn").addEventListener("click", async () => {
      const existing = card.querySelector(".breakdown");
      if (existing) {
        existing.remove();
        return;
      }
      const div = document.createElement("div");
      div.className = "breakdown card-meta";
      div.style.marginTop = "8px";
      div.textContent = FA.coachBrain === "claude" ? "🧠 breaking it down…" : "";
      card.appendChild(div);
      const steps = await Promise.resolve(FA.coach.breakdown(a));
      div.innerHTML = steps.map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join("<br>");
    });

    card.querySelector(".explain-btn").addEventListener("click", () => toggleExplain(card, a));
    card.querySelector(".precheck-btn").addEventListener("click", () => togglePrecheck(card, a));

    list.appendChild(card);
  }
}

/* ------------------------------------------------------------------ *
 * Smart Start: open what's needed, park what isn't, start the clock.
 * ------------------------------------------------------------------ */
/** The numbered inventory of safe resources Smart Setup may open. */
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
    await chrome.tabs.create({ url: target.url, active: false });
    opened.push({ label: (o.kind === "topic" ? "📖 " : "🔗 ") + (target.name || target.text || target.url), why: o.why });
  }
  let docUrl = null;
  if (plan.doc && resources.googleConnected) {
    try {
      const meta = await FA.store.getMeta();
      docUrl = meta?.[assignment.id]?.docUrl || null;
      if (!docUrl) {
        const steps = FA.coach.breakdown ? await Promise.resolve(new FA.MockCoach().breakdown(assignment)) : [];
        const { url } = await FA.google.createOutlineDoc(assignment.title, assignment.course, steps);
        docUrl = url;
        await FA.store.patchAssignmentMeta(assignment.id, { docUrl });
      }
      await chrome.tabs.create({ url: docUrl, active: false });
      opened.push({ label: "📄 your doc, outline ready", why: "" });
    } catch (e) {
      console.warn("[Focus Agent] setup doc failed (non-fatal):", e.message);
    }
  }
  return opened;
}

/** Render the "what I set up / what's yours" card in the Timer view. */
function renderSetupSummary(plan, opened, resources, assignment) {
  const box = $("setup-summary");
  const rows = [];
  if (opened.length) {
    rows.push(`<div class="su-row"><b>opened:</b> ${opened.map((o) => escapeHtml(o.label)).join(" · ")}</div>`);
  }
  if (plan.gather?.length) {
    rows.push(`<div class="su-row"><b>have ready:</b> ${plan.gather.map(escapeHtml).join(" · ")}</div>`);
  }
  rows.push(`<div class="su-focus">🎯 your part: ${escapeHtml(plan.focus)}</div>`);
  if (plan.firstMove) rows.push(`<div class="su-row">▶ first move: ${escapeHtml(plan.firstMove)}</div>`);
  box.innerHTML = `<div class="su-label">${plan.fromClaude ? "🧠 " : ""}setup</div>${rows.join("")}<div class="su-extra"></div>`;
  box.classList.remove("hidden");

  // Extra suggestions from the async brain arrive as click-to-open buttons —
  // never as surprise tabs mid-session.
  box.renderExtras = (extraOpens) => {
    const wrap = box.querySelector(".su-extra");
    wrap.innerHTML = "";
    for (const o of extraOpens) {
      const target = o.kind === "link" ? resources.links[o.i] : resources.topics[o.i];
      if (!target?.url) continue;
      const btn = document.createElement("button");
      btn.textContent = "+ open " + (target.name || target.text || "resource").slice(0, 40);
      btn.title = o.why || "";
      btn.addEventListener("click", () => chrome.tabs.create({ url: target.url, active: false }));
      wrap.appendChild(btn);
    }
  };
}

async function smartStart(assignment, minOverride) {
  // 1. Park distracting tabs into a separate minimized window (reversible —
  //    nothing is closed, the tabs just get out of the way).
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
      const parkingLot = await chrome.windows.create({
        tabId: distractors[0].id,
        state: "minimized",
        focused: false,
      });
      if (distractors.length > 1) {
        await chrome.tabs.move(distractors.slice(1).map((t) => t.id), {
          windowId: parkingLot.id,
          index: -1,
        });
      }
    }
  } catch (e) {
    console.warn("[Focus Agent] Tab parking failed (non-fatal):", e.message);
  }

  // 2. Smart Setup: read the instructions, open what they call for.
  //    Rules plan runs INSTANTLY (cached brain plan when we have one);
  //    the brain upgrades the summary + suggests extras asynchronously.
  const resources = await buildSetupResources(assignment);
  const meta = await FA.store.getMeta();
  let plan = meta?.[assignment.id]?.setupPlan || new FA.MockCoach().setup(assignment, resources);

  // 3. Open the assignment itself (active), then the planned resources.
  if (assignment.url) {
    await chrome.tabs.create({ url: assignment.url, active: true });
  }
  let opened = [];
  try {
    opened = await executeSetupPlan(assignment, plan, resources);
  } catch (e) {
    console.warn("[Focus Agent] setup execution failed (non-fatal):", e.message);
  }

  // 4. Start the focus session and show what got set up.
  await startSession(assignment, minOverride);
  switchTab("timer");
  renderSetupSummary(plan, opened, resources, assignment);

  // 5. Brain upgrade in the background: better summary + extra suggestions
  //    (rendered as buttons — the async brain never opens tabs by itself).
  if (FA.coachBrain === "claude" && !plan.fromClaude) {
    Promise.resolve(FA.coach.setup(assignment, resources))
      .then(async (brainPlan) => {
        if (!brainPlan.fromClaude) return;
        await FA.store.patchAssignmentMeta(assignment.id, { setupPlan: brainPlan });
        const alreadyOpened = new Set((plan.opens || []).map((o) => `${o.kind}:${o.i}`));
        const extras = (brainPlan.opens || []).filter((o) => !alreadyOpened.has(`${o.kind}:${o.i}`));
        renderSetupSummary(brainPlan, opened, resources, assignment);
        $("setup-summary").renderExtras?.(extras);
      })
      .catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * Timer / sessions
 * ------------------------------------------------------------------ */
async function startSession(assignment, minOverride) {
  const settings = await FA.store.getSettings();
  const plannedMin =
    minOverride ??
    (assignment?.estMin
      ? Math.min(Math.max(assignment.estMin, 15), 50) // one sitting: 15-50 min
      : settings.sessionMin);

  await FA.store.startSession(
    assignment ?? { id: "free", title: "Free focus session", course: "" },
    plannedMin
  );
  chrome.runtime.sendMessage({ type: "SESSION_STARTED" }).catch(() => {});
  await restoreTimerIfActive();
}

async function endSession(abandon = false) {
  clearInterval(timerInterval);
  timerInterval = null;

  let record = null;
  if (abandon) {
    // Abandoned sessions vanish — no XP, no session record, no shame spiral.
    await chrome.storage.local.set({ activeSession: null });
  } else {
    record = await FA.store.endSession(); // records session + time-spent (XP source)
  }
  chrome.runtime.sendMessage({ type: "SESSION_ENDED" }).catch(() => {});

  $("timer-active").classList.add("hidden");
  $("timer-idle").classList.remove("hidden");
  $("setup-summary").classList.add("hidden");
  await refreshAll();

  // Session debrief: the coach reacts to what actually happened.
  if (record) showDebrief(record);
}

/** One closing line from the coach after a real session. */
async function showDebrief(record) {
  const toast = $("debrief-toast");
  const sessions = await FA.store.getSessions();
  const weekAgo = Date.now() - 7 * 86400000;
  const week = sessions.filter((s) => s.endedAt > weekAgo);
  const weekStats = {
    sessions: week.length,
    totalMin: week.reduce((a, s) => a + s.actualMin, 0),
    avgDistractions:
      week.length ? Math.round((week.reduce((a, s) => a + (s.distractions || 0), 0) / week.length) * 10) / 10 : 0,
  };

  const show = ({ line }, fromClaude) => {
    toast.textContent = (fromClaude ? "🧠 " : "") + line;
    toast.classList.remove("hidden");
  };
  show(new FA.MockCoach().debrief(record), false);
  if (FA.coachBrain === "claude") {
    Promise.resolve(FA.coach.debrief(record, weekStats)).then((d) => show(d, true)).catch(() => {});
  }
  setTimeout(() => toast.classList.add("hidden"), 20000);
}

/** Rebuild the ticking clock from storage (survives panel close/reopen). */
async function restoreTimerIfActive() {
  const session = await FA.store.getActiveSession();
  if (!session) return;

  $("timer-idle").classList.add("hidden");
  $("timer-active").classList.remove("hidden");
  $("timer-task").textContent = session.title + (session.course ? ` · ${session.course}` : "");

  // Feeling check-in: one optional tap, only until answered or skipped.
  const moodRow = $("mood-row");
  const moodResp = $("mood-response");
  if (!session.mood && !session.moodSkipped) {
    moodRow.classList.remove("hidden");
    moodResp.classList.add("hidden");
  } else {
    moodRow.classList.add("hidden");
  }

  clearInterval(timerInterval);
  const RING_C = 603.19; // 2π × r(96), must match panel.css stroke-dasharray
  const ring = $("ring-fg");
  const tick = () => {
    const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
    const target = session.plannedMin * 60;
    const left = target - elapsed;
    const abs = Math.abs(left);
    const mm = String(Math.floor(abs / 60)).padStart(2, "0");
    const ss = String(abs % 60).padStart(2, "0");
    $("timer-clock").textContent = (left < 0 ? "+" : "") + `${mm}:${ss}`;
    $("timer-sub").textContent =
      left >= 0
        ? `planned ${session.plannedMin} min · distractions: ${session.distractions || 0}`
        : `overtime — nothing wrong with finishing the thought`;

    // The ring drains as the session runs; overtime turns it amber and full.
    if (ring) {
      if (left >= 0) {
        ring.classList.remove("overtime");
        ring.style.strokeDashoffset = (RING_C * Math.min(elapsed / target, 1)).toFixed(1);
      } else {
        ring.classList.add("overtime");
        ring.style.strokeDashoffset = 0;
      }
    }
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

/* ------------------------------------------------------------------ *
 * Chat with the coach
 * ------------------------------------------------------------------ */
let chatHistory = [];

async function loadChat() {
  const obj = await chrome.storage.local.get("chatHistory");
  chatHistory = obj.chatHistory || [];
  renderChatMessages();
}

/** Small grey status line in the chat stream (not stored in history). */
function appendSystemLine(text) {
  const wrap = $("chat-messages");
  const el = document.createElement("div");
  el.className = "msg system muted small";
  el.textContent = text;
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
}

function renderChatMessages() {
  const wrap = $("chat-messages");
  wrap.innerHTML = "";
  if (!chatHistory.length) {
    wrap.innerHTML =
      '<div class="empty-note">talk to your coach — it knows your assignments, your pace and your week.</div>';
  }
  for (const m of chatHistory) {
    const el = document.createElement("div");
    el.className = "msg " + (m.role === "user" ? "me" : "coach");
    el.textContent = m.text;
    wrap.appendChild(el);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function showTyping() {
  const wrap = $("chat-messages");
  const el = document.createElement("div");
  el.className = "msg coach";
  el.id = "typing-msg";
  el.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
}

async function sendChat(text) {
  const msg = (text ?? $("chat-input").value).trim();
  if (!msg) return;
  $("chat-input").value = "";

  chatHistory.push({ role: "user", text: msg, at: Date.now() });
  renderChatMessages();
  showTyping();

  const sessions = await FA.store.getSessions();
  const weekAgo = Date.now() - 7 * 86400000;
  const week = sessions.filter((s) => s.endedAt > weekAgo);
  // Eyes: if the active tab is a Google Doc and Google is connected, read it
  // so the coach can talk about what's actually on screen.
  let doc = null;
  let docNote = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /docs\.google\.com\/document\/d\//.test(tab.url)) {
      // readDoc tries the cookie-based export first (no Google sign-in
      // needed), then the Docs API if Google is connected.
      const d = await FA.google.readDoc(tab.url);
      doc = { title: d.title || tab.title?.replace(/ - Google Docs$/, "") || "", text: d.text.slice(0, 30000), truncated: d.text.length > 30000 };
    }
  } catch (e) {
    docNote = `Couldn't read the open doc: ${e.message}`;
  }
  // Show the read status in the chat itself — the student shouldn't have to
  // guess whether the coach can see the doc.
  if (doc) {
    appendSystemLine(`📄 reading "${doc.title || "the open doc"}" (${doc.text.length.toLocaleString()} chars${doc.truncated ? ", truncated" : ""})`);
  } else if (docNote) {
    appendSystemLine(`⚠️ ${docNote}`);
  }

  const settings = await FA.store.getSettings();
  const context = {
    ranked,
    brain: snapshot ? FA.snapshotForBrain(snapshot, { maxAssignments: 0 }) : null,
    mode: settings.mode || "tutor",
    doc,
    docNote,
    stats: {
      streak: FA.computeStreak(sessions),
      sessionsThisWeek: week.length,
      minutesThisWeek: week.reduce((a, s) => a + s.actualMin, 0),
    },
  };

  const { reply } = await Promise.resolve(FA.coach.chat(chatHistory, context));
  document.getElementById("typing-msg")?.remove();
  chatHistory.push({ role: "coach", text: reply, at: Date.now() });
  chatHistory = chatHistory.slice(-40); // cap stored history
  await chrome.storage.local.set({ chatHistory });
  renderChatMessages();
}

/* ------------------------------------------------------------------ *
 * Panic Button
 * ------------------------------------------------------------------ */
async function renderPanicPlan() {
  const minutes = parseInt($("panic-minutes").value, 10) || 120;
  const wrap = $("panic-plan");
  if (FA.coachBrain === "claude") {
    wrap.innerHTML = '<div class="pep">🧠 Triaging your night with the real brain… (~15s)</div>';
  }
  const { blocks, sacrifices, pep } = await Promise.resolve(FA.coach.panicPlan(ranked, minutes));
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
      el.innerHTML = `<span class="plan-time"></span><span><span class="plan-title"></span><br><span class="plan-note"></span></span>`;
      el.querySelector(".plan-time").textContent = `${b.start}–${b.end}`;
      el.querySelector(".plan-title").textContent = `${b.title} (${b.course})`;
      el.querySelector(".plan-note").textContent = b.note;
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

/* ------------------------------------------------------------------ *
 * Commitments
 * ------------------------------------------------------------------ */
async function addCommitment() {
  const text = $("commit-text").value.trim();
  const time = $("commit-time").value; // "16:00"
  if (!text || !time) return;

  const [hh, mm] = time.split(":").map(Number);
  const due = new Date();
  due.setHours(hh, mm, 0, 0);
  if (due < new Date()) due.setDate(due.getDate() + 1); // past time = tomorrow

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

/* ------------------------------------------------------------------ *
 * Stats + Autopsy
 * ------------------------------------------------------------------ */
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

  // Autopsy: instant rules version, upgraded in place by the real brain.
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
    Promise.resolve(FA.coach.autopsy(sessions, commitments))
      .then((lines) => renderInsights(lines, true))
      .catch(() => {});
  }

  renderCharts(sessions);
}

/** The v0.3 analytics: real charts from real on-device data. */
function renderCharts(sessions) {
  // Focus trends
  $("chart-daily").innerHTML = FA.barChart(FA.minutesPerDay(sessions, 14), { unit: " min" });
  $("chart-hours").innerHTML = FA.barChart(FA.sessionsByHour(sessions), { unit: " min", color: "#6ee7a8" });

  // Distraction analytics
  const trend = FA.distractionTrend(sessions, 10);
  $("chart-distract-trend").innerHTML = trend.length >= 2
    ? FA.lineChart(trend, { color: "#fb7185" })
    : '<div class="empty-note small">Log a few sessions and this fills in.</div>';

  const sites = FA.distractionsBySite(sessions);
  if (sites.length) {
    $("chart-distract-sites").innerHTML = FA.hbarChart(sites, { unit: "×" });
    const worst = sites[0];
    const totalCost = sites.reduce((a, s) => a + s.costMin, 0);
    $("distract-cost").textContent =
      `${worst.label} is your #1 offender (${worst.value}×). Estimated total refocus cost: ~${totalCost} min.`;
  } else {
    $("chart-distract-sites").innerHTML = '<div class="empty-note small">No distractions logged. Either you\'re a machine or you haven\'t run a session yet.</div>';
    $("distract-cost").textContent = "";
  }
}

/* ------------------------------------------------------------------ *
 * Quests + Boss battles
 * ------------------------------------------------------------------ */
function renderQuests(meta, sessions, questEvents) {
  const xp = FA.totalXp(sessions, questEvents);
  const { level, progress, needed } = FA.levelFor(xp);
  $("level-box").innerHTML = `
    <div class="level-title">Level ${level} · ${xp} XP</div>
    <div class="xp-bar"><div class="xp-fill" style="width:${Math.min((progress / needed) * 100, 100)}%"></div></div>
    <div class="xp-sub">${needed - progress} XP to level ${level + 1} — 1 focused minute = 1 XP</div>`;

  // Bosses
  const bosses = FA.findBosses(assignments, meta, sessions);
  const bossList = $("boss-list");
  bossList.innerHTML = "";
  if (!bosses.length) {
    bossList.innerHTML = '<div class="empty-note small">No bosses on the horizon. (Tests on your portal show up here.)</div>';
  }
  for (const b of bosses) {
    const pct = b.maxHp ? (b.hp / b.maxHp) * 100 : 0;
    const el = document.createElement("div");
    el.className = "boss";
    el.innerHTML = `
      <div class="boss-name">⚔️ <span class="b-name"></span></div>
      <div class="boss-due"></div>
      <div class="hp-bar"><div class="hp-fill" style="width:${pct}%"></div></div>
      <div class="hp-label">HP ${b.hp}/${b.maxHp}</div>
      <div class="boss-hint">Damage it: finish its lead-up work (${b.doneLeadUps}/${b.leadUps.length} done) and log study sessions for ${b.test.course} (${b.studySessions}/2).</div>`;
    el.querySelector(".b-name").textContent = b.test.title;
    el.querySelector(".boss-due").textContent = `${b.test.course} · ${dueLabel(b.test)}`;
    bossList.appendChild(el);
  }

  // Quest board = remaining assignments with XP bounties
  const questList = $("quest-list");
  questList.innerHTML = "";
  for (const a of ranked) {
    const el = document.createElement("div");
    el.className = "card commit-item";
    el.innerHTML = `<span class="q-title small"></span><span class="quest-xp">+${a.estMin} XP</span>`;
    el.querySelector(".q-title").textContent = `${a.title} (${a.course})`;
    questList.appendChild(el);
  }
}

/* ------------------------------------------------------------------ *
 * Tabs + wiring
 * ------------------------------------------------------------------ */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);

$("mode-select").addEventListener("change", async (e) => {
  await FA.store.setSettings({ mode: e.target.value });
});
$("source-select").addEventListener("change", async (e) => {
  await FA.store.setSettings({ dataSource: e.target.value });
  await loadAssignments();
  await refreshAll();
});

$("refresh-btn").addEventListener("click", reloadFromPortal);

// G chip: connect / show Google status. Token lives in Chrome, not in us.
async function renderGoogleChip() {
  const on = await FA.google.isConnected();
  const chip = $("google-btn");
  chip.textContent = on ? "G ✓" : "G";
  chip.title = on ? "Google connected (Docs + Calendar). Click to disconnect." : "Connect Google (Docs + Calendar)";
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
      // Surface the real reason in the UI — the panel's console is hidden.
      console.warn("[Focus Agent] Google connect failed:", e.message);
      const msg = /not signed in/i.test(e.message)
        ? "Chrome itself isn't signed in to a Google account. Click your profile icon (top-right of Chrome) → sign in with your personal Gmail, then try G again."
        : /bad client id|invalid_client|OAuth2 not granted|manifest/i.test(e.message)
          ? `Google rejected the client id (${e.message}). The console setting can take a few minutes to propagate — try again shortly.`
          : `Google sign-in failed: ${e.message}`;
      sourceNotice = "⚠️ " + msg;
      $("forecast-headline").textContent = sourceNotice;
      switchTab("today");
    }
  }
  renderGoogleChip();
});
renderGoogleChip();
$("panic-btn").addEventListener("click", renderPanicPlan);

// Mood check-in wiring: dread gets a different response than fine.
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
      resp.textContent =
        "Dread means it feels too big — that's the dread talking, not the task. Do the tiniest first piece and nothing else. The feeling changes after you start.";
      resp.classList.remove("hidden");
      setTimeout(() => resp.classList.add("hidden"), 15000);
    } else if (mood === "meh") {
      resp.textContent = "Fair. Autopilot is fine — the timer does the caring for you.";
      resp.classList.remove("hidden");
      setTimeout(() => resp.classList.add("hidden"), 8000);
    }
  })
);

// Chat wiring
$("chat-send").addEventListener("click", () => sendChat());
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});
document.querySelectorAll(".chat-chip").forEach((chip) =>
  chip.addEventListener("click", () => sendChat(chip.dataset.msg))
);

// ✏️ Annotate: inject the drawing overlay into the active tab. Injecting
// again toggles it off (the annotator handles its own teardown).
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
$("free-session-btn").addEventListener("click", () => startSession(null));
$("end-session-btn").addEventListener("click", () => endSession(false));
$("abandon-session-btn").addEventListener("click", () => endSession(true));
$("commit-btn").addEventListener("click", addCommitment);

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
(async () => {
  // Pick the brain first: real Claude via the local bridge if it's running,
  // built-in rules otherwise. The badge tells Ben which one he's got.
  const brain = await FA.initCoach();
  $("brain-badge").textContent = brain === "claude" ? "🧠" : "⚙️";
  $("brain-badge").title =
    brain === "claude"
      ? "Real Claude brain (local bridge running)"
      : "Rule-based coach — start the bridge for the real brain: python3 bridge/coach_server.py";

  await loadAssignments();
  await refreshAll();
  await loadChat();

  // The popup's Panic shortcut asks us to open on a specific tab.
  const { panelOpenTab } = await chrome.storage.local.get("panelOpenTab");
  if (panelOpenTab) {
    switchTab(panelOpenTab);
    if (panelOpenTab === "panic") renderPanicPlan();
    await chrome.storage.local.remove("panelOpenTab");
  }
})();
