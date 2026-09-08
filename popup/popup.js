/**
 * popup/popup.js - The one-glance version: the coach's top pick and one
 * button. Smart Start hands off to the side panel, which does the actual
 * work (tab parking, setup, clock, chat) so there is exactly one code path.
 */

const $ = (id) => document.getElementById(id);

async function loadRanked() {
  const cache = await FA.store.getCachedAssignments();
  const assignments = cache?.items || [];

  const [meta, sessions] = await Promise.all([FA.store.getMeta(), FA.store.getSessions()]);
  $("streak").textContent = `🔥 ${FA.computeStreak(sessions)}`;
  return FA.rankAssignments(assignments, meta, sessions);
}

/** Open the side panel; optionally tell it to Smart Start an assignment. */
async function openPanel(startId) {
  if (startId) await chrome.storage.local.set({ panelStart: startId });
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
  window.close();
}

(async () => {
  $("open-panel").addEventListener("click", () => openPanel());

  const ranked = await loadRanked();
  let picked = null;

  // Instant rules pick; the real brain upgrades it in place.
  const show = ({ assignment, reason }, fromClaude) => {
    picked = assignment;
    const prefix = fromClaude ? "🧠 " : "";
    if (assignment) {
      $("next-title").textContent = prefix + assignment.title;
      $("next-meta").textContent = `${assignment.course} · ~${assignment.estMin} min — ${reason}`;
      $("start").disabled = false;
    } else {
      $("next-title").textContent = ranked.length ? "Nothing pending 🏖️" : "No portal yet";
      $("next-meta").textContent = ranked.length ? prefix + reason : "Open your school portal (myPoly, Canvas…) in a tab, then open the panel.";
      $("start").disabled = true;
    }
  };
  show(new FA.MockCoach().pick(ranked), false);
  $("start").addEventListener("click", () => picked && openPanel(picked.id));

  const brain = await FA.initCoach();
  if (brain === "claude") {
    Promise.resolve(FA.coach.pick(ranked)).then((p) => show(p, true)).catch(() => {});
  }
})();
