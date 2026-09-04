/**
 * scripts/smoke-toolbar.js - Load annotate/selection-toolbar.js into a jsdom
 * page with a fake chrome.*, select text, click 🖍 annotate, check the
 * highlight is painted + stored, then reload the page and check it comes
 * back anchored to the same words (text anchoring, not pixels).
 * Run: NODE_PATH=<dir with jsdom> node scripts/smoke-toolbar.js
 */
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = fs.readFileSync(path.join(ROOT, "annotate/selection-toolbar.js"), "utf8");

const PAGE = `<!doctype html><html><head><title>Columbus reading</title></head><body>
<article>
<h1>Christopher Columbus</h1>
<p id="p1">In 1492, Columbus sailed west from Spain with three ships. He believed he could reach Asia by crossing the Atlantic.</p>
<p id="p2">The people he met on the islands he called Indians. He wrote that they would make good servants, and he took several back to Spain.</p>
<p id="p3">He believed he could reach Asia by a different route on later voyages, but he never did.</p>
</article></body></html>`;

const store = {};
const errors = [];
const calls = [];
function makeChrome() {
  return {
    storage: {
      local: {
        async get(k) { return { [k]: store[k] }; },
        async set(o) { Object.assign(store, o); },
      },
    },
    runtime: {
      sendMessage(msg, cb) {
        calls.push(msg);
        if (msg.type === "COACH_CALL" && msg.method === "annotateQuestion") cb({ ok: true, result: { question: "Why 'servants' here?" } });
        else if (msg.type === "COACH_CALL" && msg.method === "summarize") cb({ ok: true, result: { summary: "• test summary", fromClaude: false } });
        else cb({ ok: true });
      },
      lastError: undefined,
    },
  };
}

function boot(html) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.detail?.stack || e.message));
  const dom = new JSDOM(html, { url: "https://reading.example.edu/columbus/ch3", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.chrome = makeChrome(); } });
  // jsdom has no layout: give ranges/elements a fake box so placement code runs.
  const box = () => ({ left: 100, top: 200, right: 300, bottom: 220, width: 200, height: 20 });
  dom.window.Range.prototype.getBoundingClientRect = box;
  dom.window.Element.prototype.getBoundingClientRect = box;
  try { dom.window.eval(SCRIPT); } catch (e) { errors.push("load: " + e.stack); }
  return dom;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => results.push(`${ok ? "✓" : "✗"} ${n}${x ? " — " + x : ""}`);

function selectText(win, el, from, to) {
  const range = win.document.createRange();
  range.setStart(el.firstChild, from);
  range.setEnd(el.firstChild, to);
  const s = win.getSelection();
  s.removeAllRanges();
  s.addRange(range);
  win.document.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
}

(async () => {
  let dom = boot(PAGE);
  let { window: w } = dom;
  await sleep(200);
  const host = () => w.document.getElementById("fa-sel-host");
  check("toolbar host injected", Boolean(host()));
  const root = () => host().shadowRoot;

  // Select "good servants" in p2 (ambiguous phrase "He believed he could reach Asia" appears twice — tested below)
  const p2 = w.document.getElementById("p2");
  const i = p2.textContent.indexOf("good servants");
  selectText(w, p2, i, i + "good servants".length);
  await sleep(50);
  check("bubbles appear on selection", root().getElementById("bar").classList.contains("show"));
  root().querySelector('[data-act="annotate"]').click();
  await sleep(100);
  const marks = w.document.querySelectorAll("mark[data-fa-hl]");
  check("highlight painted", marks.length === 1 && marks[0].textContent === "good servants", marks[0]?.textContent);
  check("note popover opens with coach question", root().getElementById("pop").classList.contains("show") && root().getElementById("q").textContent.includes("servants"));
  root().getElementById("note").value = "He saw people as labor from day one.";
  root().querySelector('[data-act="save"]').click();
  await sleep(50);
  const key = "fa-hl:https://reading.example.edu/columbus/ch3";
  check("stored under page key with text selector", store[key]?.[0]?.sel?.exact === "good servants" && store[key][0].note.startsWith("He saw"));
  check("note posted to assignment thread", calls.some((c) => c.type === "THREAD_APPEND" && c.kind === "annotation"));

  // Ambiguous phrase: select the SECOND "He believed he could reach Asia" (in p3) and make sure it anchors there.
  const p3 = w.document.getElementById("p3");
  const phrase = "He believed he could reach Asia";
  selectText(w, p3, 0, phrase.length);
  await sleep(50);
  root().querySelector('[data-act="annotate"]').click();
  await sleep(100);
  check("second highlight painted", w.document.querySelectorAll("mark[data-fa-hl]").length === 2);
  check("selector carries context", store[key][1].sel.suffix.startsWith(" by a different route"));

  // Summarize path (fake coach, no on-device model in jsdom)
  selectText(w, w.document.getElementById("p1"), 0, 40);
  await sleep(50);
  root().querySelector('[data-act="summarize"]').click();
  await sleep(100);
  check("summarize renders coach result", root().getElementById("body").textContent.includes("test summary"));

  // Reload: highlights must come back anchored to the same words.
  dom = boot(PAGE);
  w = dom.window;
  await sleep(300);
  const again = [...w.document.querySelectorAll("mark[data-fa-hl]")];
  check("highlights restored after reload", again.length === 2, `${again.length}`);
  check("first anchored to same words", again.some((m) => m.textContent === "good servants"));
  const asia = again.find((m) => m.textContent.startsWith("He believed"));
  check("ambiguous phrase anchored to the RIGHT paragraph", asia && asia.closest("p")?.id === "p3", asia?.closest("p")?.id);

  // Reflow-proof: insert a paragraph above and reload — same words still highlighted.
  const shifted = PAGE.replace('<p id="p1">', '<p id="p0">A brand new paragraph was added above everything else.</p><p id="p1">');
  dom = boot(shifted);
  w = dom.window;
  await sleep(300);
  const after = [...w.document.querySelectorAll("mark[data-fa-hl]")].map((m) => m.textContent);
  check("survives content inserted above (text anchoring)", after.includes("good servants") && after.some((t) => t.startsWith("He believed")), after.join(" | "));

  console.log(results.join("\n"));
  if (errors.length) console.log("\nERRORS:\n" + errors.join("\n\n"));
  const failed = results.filter((r) => r.startsWith("✗")).length;
  console.log(failed || errors.length ? `\n${failed} FAILED` : "\nALL PASSED");
  process.exit(failed || errors.length ? 1 : 0);
})();
