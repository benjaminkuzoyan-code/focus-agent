/**
 * viewer/fa-viewer.js - Runs inside our pdf.js viewer page.
 *
 * The viewer fetches the PDF from wherever it lives, which needs host
 * permission for that origin. If we don't have it yet, show one button that
 * asks for it (permission prompts must come from a click on an extension
 * page — this is that click), then reload.
 */
(() => {
  const file = new URL(location.href).searchParams.get("file");
  if (!file || !/^https?:/.test(file)) return;
  let origin;
  try {
    origin = new URL(file).origin + "/*";
  } catch {
    return;
  }
  const banner = document.createElement("div");
  banner.style.cssText =
    "position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:99999;background:#0f1117;color:#eef0f8;border:1px solid #6c7cff;border-radius:12px;padding:10px 14px;font:13px -apple-system,sans-serif;display:none;gap:10px;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.5)";
  banner.innerHTML = '<span id="fa-msg"></span><button id="fa-allow" style="background:#6c7cff;color:#fff;border:none;border-radius:999px;padding:6px 12px;cursor:pointer">allow</button>';
  document.body.appendChild(banner);
  const show = (msg) => {
    banner.querySelector("#fa-msg").textContent = msg;
    banner.style.display = "flex";
  };
  banner.querySelector("#fa-allow").addEventListener("click", async () => {
    try {
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (ok) location.reload();
      else show("Permission declined — the PDF can't be loaded from " + new URL(file).hostname + ".");
    } catch (e) {
      show("Couldn't ask for permission: " + e.message);
    }
  });
  chrome.permissions.contains({ origins: [origin] }, (has) => {
    if (!has) show("Let Focus Agent load PDFs from " + new URL(file).hostname + " so you can highlight them.");
  });
  // pdf.js reports load failures on the document; surface the common one.
  window.addEventListener("error", (e) => {
    if (/fetch|network|CORS|Failed to load/i.test(String(e.message))) show("Couldn't load the PDF from " + new URL(file).hostname + " — tap allow, or open it from the portal again.");
  });
})();
