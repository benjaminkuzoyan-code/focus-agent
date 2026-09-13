// Seed the fake storage with the fixture assignments before panel.js boots.
window.__seed((async () => {
  const items = await FA.adapters.mock.fetchAssignments();
  window.__store.assignmentsCache = { items, fetchedAt: Date.now(), source: "blackbaud" };
})());
