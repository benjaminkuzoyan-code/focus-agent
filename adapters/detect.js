/**
 * adapters/detect.js - Which school system is this page? Used by the
 * "connect my school" button and the copy-debug-info report, so a friend
 * at another school produces DATA ("Schoology, not supported yet") instead
 * of "it didn't work".
 *
 * Runs in an isolated world: only DOM + host are available (no page JS
 * globals like window.ENV), so detection leans on hostnames and markup.
 *
 *   FA.detectPortal(host, doc) → { type, supported, evidence[] }
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  const SUPPORTED = new Set(["blackbaud", "canvas", "classroom"]);

  FA.detectPortal = function detectPortal(host = location.hostname, doc = document) {
    const ev = [];
    const has = (sel) => {
      try {
        return Boolean(doc.querySelector(sel));
      } catch {
        return false;
      }
    };
    const body = doc.body?.className || "";
    let type = "unknown";

    if (/myschoolapp\.com$|blackbaud\.com$/.test(host) || has('script[src*="blackbaud"]') || has("#site-header-container")) {
      type = "blackbaud";
      ev.push(/myschoolapp|blackbaud/.test(host) ? `host ${host}` : "blackbaud markup");
    } else if (/instructure\.com$/.test(host) || /\bic-app\b/.test(body) || has('meta[name="csrf-token"]') && has("#application") || has('link[href*="instructure"]')) {
      type = "canvas";
      ev.push(/instructure/.test(host) ? `host ${host}` : "Canvas markup (ic-app / #application)");
    } else if (host === "classroom.google.com") {
      type = "classroom";
      ev.push("host classroom.google.com");
    } else if (/schoology\.com$/.test(host) || has("#schoology-app, .s-navigation-bar, #site-navigation .sm-navigation-bar")) {
      type = "schoology";
      ev.push("Schoology");
    } else if (/powerschool\.com$/.test(host) || /\/guardian\/|\/public\//.test(location.pathname) && has("#psLogo, .psLogo")) {
      type = "powerschool";
      ev.push("PowerSchool");
    } else if (/infinitecampus\.(com|org)$/.test(host) || has('link[href*="infinitecampus"]')) {
      type = "infinitecampus";
      ev.push("Infinite Campus");
    } else if (/brightspace|d2l/.test(host) || has(".d2l-page-main, d2l-navigation")) {
      type = "brightspace";
      ev.push("Brightspace / D2L");
    } else if (/blackboard\.com$/.test(host) || has("#globalNavPageNavArea, .bb-app")) {
      type = "blackboard";
      ev.push("Blackboard Learn");
    } else if (/skyward/.test(host) || has('link[href*="skyward"]')) {
      type = "skyward";
      ev.push("Skyward");
    } else if (/moodle/.test(host) || /\bpagelayout-/.test(body) || has('link[href*="/theme/"][href*="moodle"]')) {
      type = "moodle";
      ev.push("Moodle");
    } else if (/schoolsoft|managebac|faria/.test(host)) {
      type = "managebac";
      ev.push("ManageBac");
    }
    if (!ev.length) ev.push(`no known markers on ${host}`);
    return { type, supported: SUPPORTED.has(type), evidence: ev, host };
  };
})();
