/**
 * annotate/snip.js - Drag a rectangle over the page to pick what the coach
 * should look at. Injected by the panel right before it screenshots the tab
 * (chrome.tabs.captureVisibleTab), so the crop happens on OUR copy of the
 * pixels — nothing here reads the page.
 *
 *   drag      → that region
 *   click     → the whole visible screen
 *   Esc       → cancel
 *
 * Exposes globalThis.__faSnip(): Promise<{x,y,w,h,dpr} | "all" | null>.
 * The panel calls it in a second executeScript and awaits the promise.
 * Works on Google Docs (canvas-rendered, no text selection), Drive previews,
 * images — anywhere a DOM overlay can sit.
 */
(() => {
  if (globalThis.__faSnip) return;
  globalThis.__faSnip = () =>
    new Promise((resolve) => {
      const host = document.createElement("div");
      host.id = "fa-snip-host";
      host.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;";
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = `
        <style>
          .dim { position:absolute; inset:0; background:rgba(10,12,20,.35); }
          .box { position:absolute; border:2px solid #a78bfa; background:rgba(167,139,250,.12); box-shadow:0 0 0 9999px rgba(10,12,20,.35); display:none; }
          .hint { position:absolute; top:14px; left:50%; transform:translateX(-50%); background:rgba(20,22,30,.92); color:#eef; font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; padding:8px 14px; border-radius:999px; pointer-events:none; white-space:nowrap; }
        </style>
        <div class="dim"></div><div class="box"></div>
        <div class="hint">drag to pick a region · click for the whole screen · Esc to cancel</div>`;
      const dim = shadow.querySelector(".dim");
      const box = shadow.querySelector(".box");
      let start = null;
      const done = (val) => {
        window.removeEventListener("keydown", onKey, true);
        host.remove();
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done(null);
        }
      };
      window.addEventListener("keydown", onKey, true);
      host.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start = { x: e.clientX, y: e.clientY };
        box.style.display = "block";
        box.style.left = start.x + "px";
        box.style.top = start.y + "px";
        box.style.width = "0px";
        box.style.height = "0px";
        dim.style.display = "none";
      });
      host.addEventListener("mousemove", (e) => {
        if (!start) return;
        const x = Math.min(e.clientX, start.x), y = Math.min(e.clientY, start.y);
        box.style.left = x + "px";
        box.style.top = y + "px";
        box.style.width = Math.abs(e.clientX - start.x) + "px";
        box.style.height = Math.abs(e.clientY - start.y) + "px";
      });
      host.addEventListener("mouseup", (e) => {
        if (!start) return;
        const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
        const x = Math.min(e.clientX, start.x), y = Math.min(e.clientY, start.y);
        start = null;
        // A click (no real drag) means "all of it".
        if (w < 12 || h < 12) return done("all");
        done({ x, y, w, h, dpr: window.devicePixelRatio || 1 });
      });
      document.documentElement.appendChild(host);
    });
})();
