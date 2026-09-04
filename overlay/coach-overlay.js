/**
 * overlay/coach-overlay.js - The coach, drawn directly onto the portal page.
 *
 * Runs after content.js (same isolated world, so fetchNormalized() from
 * content.js is callable). Two jobs:
 *
 *   1. BADGES — find the portal's own assignment rows by their title text
 *      and pin priority badges on them ("START HERE" on the coach's pick,
 *      overdue/due-soon flags on the rest). MutationObserver re-applies
 *      when the portal SPA re-renders.
 *
 *   2. COACH BUBBLE — a floating widget (shadow DOM, bottom-right) showing
 *      the top pick + reason, a Start Focus button, and a live mini-timer
 *      HUD while a session runs.
 */

(() => {
  let ranked = [];
  let pick = null;
  let activeSession = null;
  let bubbleRefs = null;
  let decorateQueued = false;
  let hudInterval = null;

  /* ---------------------------------------------------------------- *
   * Boot: fetch → rank (in background) → decorate + bubble
   * ---------------------------------------------------------------- */
  async function boot() {
    try {
      // fetchNormalized() is defined by content.js in this same world.
      const assignments = await fetchNormalized();

      // Rank locally — content scripts have chrome.storage + the FA libs
      // (priority.js, ai.js via the manifest), so no background round-trip
      // is needed. Fewer moving parts, no service-worker wake-up races.
      const stored = await chrome.storage.local.get(["assignmentMeta", "sessions", "activeSession"]);
      const meta = stored.assignmentMeta || {};
      const sessions = stored.sessions || [];
      activeSession = stored.activeSession || null;

      ranked = FA.rankAssignments(assignments, meta, sessions);
      pick = FA.coach.pick(ranked);
      console.log(`[Focus Agent] overlay: ${assignments.length} assignments, pick = "${pick?.assignment?.title ?? "none"}"`);
    } catch (e) {
      console.warn("[Focus Agent] Overlay boot failed (will still show bubble):", e.message);
    }

    buildBubble();
    decorate();
    observeRerenders();
  }

  /* ---------------------------------------------------------------- *
   * Badges on the portal's own rows
   * ---------------------------------------------------------------- */

  /** Find the smallest element whose text contains the assignment title. */
  function findTitleElement(title) {
    const needle = title.trim().slice(0, 60).toLowerCase();
    if (needle.length < 6) return null; // too short to match safely

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim().toLowerCase();
      if (!text || text.length > 300) continue;
      if (text.includes(needle)) {
        const el = node.parentElement;
        // Skip our own badges/bubble and invisible nodes.
        if (!el || el.closest(".fa-badge") || el.closest("#fa-coach-bubble")) continue;
        if (el.offsetParent === null) continue;
        return el;
      }
    }
    return null;
  }

  function badgeFor(a) {
    const badge = document.createElement("span");
    badge.dataset.faAssignment = a.id;
    if (pick?.assignment && a.id === pick.assignment.id) {
      badge.className = "fa-badge fa-badge-start";
      badge.textContent = "▶ START HERE";
      badge.title = pick.reason;
    } else if (FA.hoursUntil(a.dueDate) < 0) {
      badge.className = "fa-badge fa-badge-overdue";
      badge.textContent = "OVERDUE";
    } else if (FA.hoursUntil(a.dueDate) < 30) {
      badge.className = "fa-badge fa-badge-soon";
      badge.textContent = "due soon";
    } else {
      badge.className = "fa-badge fa-badge-dot";
      badge.textContent = `~${a.estMin}m`;
      badge.title = "Focus Agent's time estimate, from how you actually work";
    }
    return badge;
  }

  function decorate() {
    for (const a of ranked) {
      // Already badged and still attached? Skip.
      const existing = document.querySelector(`[data-fa-assignment="${a.id}"]`);
      if (existing?.isConnected) continue;

      const el = findTitleElement(a.title);
      if (el) el.appendChild(badgeFor(a));
    }
  }

  function observeRerenders() {
    const observer = new MutationObserver(() => {
      if (decorateQueued) return;
      decorateQueued = true;
      setTimeout(() => {
        decorateQueued = false;
        decorate();
      }, 800); // debounce SPA render bursts
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ---------------------------------------------------------------- *
   * Coach bubble (shadow DOM so portal CSS can't touch it)
   * ---------------------------------------------------------------- */
  function buildBubble() {
    if (document.getElementById("fa-coach-bubble")) return;

    const host = document.createElement("div");
    host.id = "fa-coach-bubble";
    host.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483646;";
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; font-family: ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .bubble {
          width: 274px; color: #eef0f8;
          background: linear-gradient(150deg, rgba(30,32,52,0.92), rgba(15,16,26,0.92));
          backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
          border: 1px solid rgba(129,140,248,0.35);
          border-radius: 20px; padding: 14px;
          box-shadow: 0 12px 38px rgba(0,0,0,0.5), 0 0 24px rgba(99,102,241,0.12);
          font-size: 13px;
        }
        .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .brand {
          font-weight: 800; font-size: 11px; letter-spacing: 1.5px;
          background: linear-gradient(135deg, #818cf8, #c084fc);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        .min-btn { background: none; border: none; color: #9aa0b4; cursor: pointer; font-size: 14px; }
        .pick-title { font-weight: 700; margin-bottom: 3px; }
        .reason { color: #9aa0b4; font-size: 12px; line-height: 1.45; margin-bottom: 10px; }
        .start {
          width: 100%; background: linear-gradient(135deg, #818cf8, #c084fc);
          color: white; border: none; border-radius: 999px;
          padding: 9px; font-weight: 700; cursor: pointer; font-size: 13px;
          transition: box-shadow 0.2s, transform 0.15s;
        }
        .start:hover { box-shadow: 0 0 16px rgba(129,140,248,0.5); }
        .start:active { transform: scale(0.97); }
        .hud-clock {
          font-size: 32px; font-weight: 800; text-align: center; font-variant-numeric: tabular-nums; margin: 4px 0;
          background: linear-gradient(135deg, #818cf8, #c084fc);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        .hud-task { text-align: center; font-size: 12px; color: #9aa0b4; margin-bottom: 8px; }
        .end {
          width: 100%; background: rgba(255,255,255,0.09); color: #eef0f8; border: none;
          border-radius: 999px; padding: 8px; cursor: pointer; font-size: 12px;
        }
        .mini {
          width: auto; border-radius: 999px; padding: 9px 15px; cursor: pointer;
          background: linear-gradient(135deg, #818cf8, #c084fc);
          color: white; border: none; font-weight: 800; font-size: 15px;
          box-shadow: 0 8px 26px rgba(0,0,0,0.45), 0 0 18px rgba(99,102,241,0.25);
        }
        .hidden { display: none; }
      </style>
      <button class="mini hidden" id="mini">◎</button>
      <div class="bubble" id="full">
        <div class="head"><span class="brand">◎ FOCUS AGENT</span><button class="min-btn" id="minimize">–</button></div>
        <div id="content"></div>
      </div>`;

    document.documentElement.appendChild(host);

    const full = root.getElementById("full");
    const mini = root.getElementById("mini");
    root.getElementById("minimize").addEventListener("click", () => {
      full.classList.add("hidden");
      mini.classList.remove("hidden");
    });
    mini.addEventListener("click", () => {
      mini.classList.add("hidden");
      full.classList.remove("hidden");
    });

    bubbleRefs = { root, content: root.getElementById("content") };
    renderBubbleContent();
  }

  /**
   * When the extension is reloaded while this page is open, this content
   * script becomes orphaned: DOM access survives but every chrome.* call
   * throws "Extension context invalidated". Catch it and tell the student
   * what to do instead of silently ignoring their clicks.
   */
  function handleContextError(e) {
    if (!/context invalidated/i.test(e?.message || "")) return false;
    if (bubbleRefs) {
      bubbleRefs.content.innerHTML =
        '<div class="reason">Focus Agent was updated behind this page — refresh (⌘R) and I\'ll be right back.</div>';
    }
    return true;
  }

  function renderBubbleContent() {
    if (!bubbleRefs) return;
    const c = bubbleRefs.content;
    clearInterval(hudInterval);

    // Live session → mini timer HUD
    if (activeSession) {
      c.innerHTML = `
        <div class="hud-task"></div>
        <div class="hud-clock" id="fa-hud-clock">--:--</div>
        <button class="end" id="fa-hud-end">Done — end session</button>`;
      c.querySelector(".hud-task").textContent = activeSession.title;

      const clock = c.querySelector("#fa-hud-clock");
      const tick = () => {
        const left = activeSession.plannedMin * 60 - Math.floor((Date.now() - activeSession.startedAt) / 1000);
        const abs = Math.abs(left);
        clock.textContent = `${left < 0 ? "+" : ""}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
      };
      tick();
      hudInterval = setInterval(tick, 1000);

      c.querySelector("#fa-hud-end").addEventListener("click", async () => {
        try {
          await chrome.runtime.sendMessage({ type: "END_SESSION_FROM_PAGE" });
          activeSession = null;
          renderBubbleContent();
        } catch (e) {
          if (!handleContextError(e)) throw e;
        }
      });
      return;
    }

    // No session → the pick + start button
    if (pick?.assignment) {
      c.innerHTML = `
        <div class="pick-title"></div>
        <div class="reason"></div>
        <button class="start" id="fa-start">▶ Start focus session</button>`;
      c.querySelector(".pick-title").textContent = pick.assignment.title;
      c.querySelector(".reason").textContent = pick.reason;
      c.querySelector("#fa-start").addEventListener("click", async () => {
        try {
          const res = await chrome.runtime.sendMessage({
            type: "START_SESSION_FROM_PAGE",
            assignment: pick.assignment,
          });
          if (res?.ok) {
            activeSession = {
              title: pick.assignment.title,
              startedAt: Date.now(),
              plannedMin: res.plannedMin,
            };
            renderBubbleContent();
          }
        } catch (e) {
          if (!handleContextError(e)) throw e;
        }
      });
    } else {
      c.innerHTML = `<div class="reason">${
        pick?.reason ? "" : "Couldn't read assignments on this page yet."
      }</div>`;
      if (pick?.reason) c.querySelector(".reason").textContent = pick.reason;
    }
  }

  // Give the SPA a moment to paint before the first pass.
  setTimeout(boot, 1500);
})();
