/**
 * viewer/fa-viewer.js - Runs inside our pdf.js viewer page.
 *
 * Two ways a PDF arrives:
 *   ?file=<url>     pdf.js streams it itself (plain, public-ish URLs)
 *   ?fa_file=<url>  we ask the worker to fetch it (Drive files: Google token,
 *                   then the browser's Drive login) and open the bytes.
 * Plus a one-button banner when the PDF's host isn't granted yet.
 */
(() => {
  const params = new URL(location.href).searchParams;
  const file = params.get("file") || params.get("fa_file");
  if (!file || !/^https?:/.test(file)) return;
  let origin;
  try {
    origin = new URL(file).origin + "/*";
  } catch {
    return;
  }
  const host = new URL(file).hostname;

  const banner = document.createElement("div");
  banner.style.cssText =
    "position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:99999;background:#0f1117;color:#eef0f8;border:1px solid #6c7cff;border-radius:12px;padding:10px 14px;font:13px -apple-system,sans-serif;display:none;gap:10px;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:80vw";
  banner.innerHTML = '<span id="fa-msg"></span><button id="fa-allow" style="background:#6c7cff;color:#fff;border:none;border-radius:999px;padding:6px 12px;cursor:pointer">allow</button>';
  document.body.appendChild(banner);
  const allowBtn = banner.querySelector("#fa-allow");
  const show = (msg, withButton = true) => {
    banner.querySelector("#fa-msg").textContent = msg;
    allowBtn.style.display = withButton ? "" : "none";
    banner.style.display = "flex";
  };
  const hide = () => (banner.style.display = "none");
  allowBtn.addEventListener("click", async () => {
    try {
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (ok) location.reload();
      else show("Permission declined — the PDF can't be loaded from " + host + ".", false);
    } catch (e) {
      show("Couldn't ask for permission: " + e.message, false);
    }
  });

  const fetched = params.has("fa_file");
  chrome.permissions.contains({ origins: [origin] }, (has) => {
    if (!has) show("Let Focus Agent load PDFs from " + host + " so you can highlight them.");
    else if (fetched) openViaWorker();
  });

  function openViaWorker() {
    show("Loading the PDF from " + host + "…", false);
    chrome.runtime.sendMessage({ type: "FETCH_PDF", url: file }, async (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        show("Couldn't load it: " + (res?.error || chrome.runtime.lastError?.message || "unknown") + ". Open it in Drive once and try again.", false);
        return;
      }
      const bin = atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const app = await waitForApp();
      try {
        await app.open({ data: bytes });
        hide();
      } catch (e) {
        show("pdf.js couldn't open it: " + e.message, false);
      }
    });
  }

  function waitForApp() {
    return new Promise((resolve) => {
      const tick = () => {
        const app = globalThis.PDFViewerApplication;
        if (app?.initializedPromise) app.initializedPromise.then(() => resolve(app));
        else setTimeout(tick, 50);
      };
      tick();
    });
  }

  window.addEventListener("error", (e) => {
    if (!fetched && /fetch|network|CORS|Failed to load/i.test(String(e.message))) show("Couldn't load the PDF from " + host + " — tap allow, or open it from the portal again.");
  });
})();
