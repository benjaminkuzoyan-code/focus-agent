// Seed the fake storage with the fixture assignments before panel.js boots.
// Open panel.html?empty=1 to see the first-run state instead.
window.__seed((async () => {
  if (new URLSearchParams(location.search).get("empty") === "1") return;
  const items = await FA.adapters.mock.fetchAssignments();
  window.__store.assignmentsCache = { items, fetchedAt: Date.now(), source: "blackbaud" };
})());
