/**
 * popup/popup.js - Mini "what's next" view. The real coach lives in the
 * side panel; this is the one-glance version plus the Panic shortcut.
 */

const $ = (id) => document.getElementById(id);

async function loadRanked() {
  const settings = await FA.store.getSettings();

  let assignments = [];
  if (settings.dataSource === "mock") {
    assignments = await FA.adapters.mock.fetchAssignments();
  } else {
    const cache = await FA.store.getCachedAssignments();
    assignments = cache?.items?.length
      ? cache.items
      : await FA.adapters.mock.fetchAssignments();
  }

  const [meta, sessions] = await Promise.all([FA.store.getMeta(), FA.store.getSessions()]);
  $("streak").textContent = `🔥 ${FA.computeStreak(sessions)}`;
  return FA.rankAssignments(assignments, meta, sessions);
}

async function openPanel(tab) {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
  if (tab) await chrome.storage.local.set({ panelOpenTab: tab });
  window.close();
}

(async () => {
  $("open-panel").addEventListener("click", () => openPanel());
  $("panic").addEventListener("click", () => openPanel("panic"));

  const ranked = await loadRanked();

  // Instant rules pick; the real brain (local bridge) upgrades it in place.
  const show = ({ assignment, reason }, fromClaude) => {
    const prefix = fromClaude ? "🧠 " : "";
    if (assignment) {
      $("next-title").textContent = prefix + assignment.title;
      $("next-meta").textContent = `${assignment.course} · ~${assignment.estMin} min — ${reason}`;
    } else {
      $("next-title").textContent = "Nothing pending 🏖️";
      $("next-meta").textContent = prefix + reason;
    }
  };
  show(new FA.MockCoach().pick(ranked), false);

  const brain = await FA.initCoach();
  if (brain === "claude") {
    Promise.resolve(FA.coach.pick(ranked)).then((p) => show(p, true)).catch(() => {});
  }
})();
