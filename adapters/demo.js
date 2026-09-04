/**
 * adapters/demo.js - Adapter for the local fake portal (demo-portal/).
 *
 * DEV ONLY. Lets the full pipeline — content router → adapter → coach →
 * page overlay — run against http://localhost:8000/demo-portal/ where the
 * fake Blackbaud page renders rows with the same titles as the mock
 * dataset, so the badges land on real visible rows.
 *
 * Remove the localhost entry from manifest.json content_scripts.matches
 * before any public release; this adapter then simply never matches.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  FA.adapters = FA.adapters || {};
  FA.adapters.demo = {
    matches(host) {
      return host === "localhost" || host === "127.0.0.1";
    },
    async fetchAssignments() {
      // Same data the rest of the app demos with — titles match the rows
      // rendered by demo-portal/index.html.
      return FA.adapters.mock.fetchAssignments();
    },
  };
})();
