/**
 * annotate/selection-toolbar.js - Highlight text on any page → three bubbles:
 *
 *   🖍 Annotate   save a text-anchored highlight + your note. The coach
 *                 pre-fills a QUESTION about the passage (never an answer);
 *                 you write the note.
 *   ≡ Summarize   summarize the selection. Chrome's built-in Summarizer API
 *                 (Gemini Nano, on-device, free) first; the coach brain via
 *                 the background worker when it isn't available.
 *   ? Ask         ask the coach anything about the passage. The answer lands
 *                 here and in the assignment's chat thread if a session runs.
 *
 * Runs as a content script (isolated world) on pages the student granted,
 * and as a plain script inside our pdf.js viewer page. Self-contained: no FA
 * libs — everything brain-side goes through chrome.runtime messages.
 *
 * Highlights anchor to TEXT, not pixels: a W3C Web Annotation
 * TextQuoteSelector {exact, prefix, suffix} + TextPositionSelector fallback,
 * so they survive reflow, resize and reload. Nothing ever fires on hover.
 */
(() => {
  if (globalThis.__faSelectionToolbar) return;
  globalThis.__faSelectionToolbar = true;

  const IS_PDF_VIEWER = location.protocol === "chrome-extension:" && /\/viewer\/pdfjs\//.test(location.pathname);
  const CTX = 32; // prefix/suffix context chars for anchoring
  const COLOR = "rgba(255, 216, 59, 0.45)";

  /** Storage key: one bucket per document (PDF viewer keys on the PDF's URL). */
  function pageKey() {
    if (IS_PDF_VIEWER) {
      const sp = new URL(location.href).searchParams;
      const f = sp.get("file") || sp.get("fa_file");
      return "fa-hl:" + (f || location.href);
    }
    return "fa-hl:" + location.origin + location.pathname;
  }
  const pageTitle = () => (document.title || "").replace(/ - Google Docs$/, "").slice(0, 120);

  /* ================================================================ *
   * Anchoring — DOM Range ⇄ text selector
   * ================================================================ */
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"]);

  /** Every text node on the page (ours excluded) with its offset in the flattened text. */
  function textIndex() {
    const nodes = [];
    let text = "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName) || p.closest("#fa-sel-host")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
    return { nodes, text };
  }

  function offsetOf(idx, node, offset) {
    // Range boundaries can sit on element nodes; resolve to the first text node inside.
    if (node.nodeType !== Node.TEXT_NODE) {
      const child = node.childNodes[offset] || node;
      const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
      const first = child.nodeType === Node.TEXT_NODE ? child : walker.nextNode();
      if (!first) {
        // Past the end: use the last text node before this point.
        const before = idx.nodes.filter((e) => node.compareDocumentPosition(e.node) & Node.DOCUMENT_POSITION_PRECEDING);
        const last = before[before.length - 1];
        return last ? last.start + last.node.data.length : 0;
      }
      node = first;
      offset = 0;
    }
    const entry = idx.nodes.find((e) => e.node === node);
    return entry ? entry.start + offset : -1;
  }

  function rangeToSelector(range) {
    const idx = textIndex();
    const start = offsetOf(idx, range.startContainer, range.startOffset);
    const end = offsetOf(idx, range.endContainer, range.endOffset);
    if (start < 0 || end < 0 || end <= start) return null;
    return {
      exact: idx.text.slice(start, end),
      prefix: idx.text.slice(Math.max(0, start - CTX), start),
      suffix: idx.text.slice(end, end + CTX),
      start,
      end,
    };
  }

  /** Find the selector on the current page. Exact match, disambiguated by context. */
  function selectorToRange(sel, idx = textIndex()) {
    const { text } = idx;
    const candidates = [];
    let i = text.indexOf(sel.exact);
    while (i >= 0 && candidates.length < 50) {
      candidates.push(i);
      i = text.indexOf(sel.exact, i + 1);
    }
    if (!candidates.length) return null;
    let best = candidates[0];
    let bestScore = -1;
    for (const c of candidates) {
      const pre = text.slice(Math.max(0, c - CTX), c);
      const suf = text.slice(c + sel.exact.length, c + sel.exact.length + CTX);
      let score = 0;
      if (sel.prefix && pre.endsWith(sel.prefix.slice(-12))) score += 2;
      if (sel.suffix && suf.startsWith(sel.suffix.slice(0, 12))) score += 2;
      if (sel.start != null) score -= Math.min(1, Math.abs(c - sel.start) / 5000);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return offsetsToRange(idx, best, best + sel.exact.length);
  }

  function offsetsToRange(idx, start, end) {
    const range = document.createRange();
    let setStart = false;
    for (const e of idx.nodes) {
      const len = e.node.data.length;
      if (!setStart && start >= e.start && start <= e.start + len && (start < e.start + len || len === 0)) {
        range.setStart(e.node, start - e.start);
        setStart = true;
      }
      if (setStart && end >= e.start && end <= e.start + len) {
        range.setEnd(e.node, end - e.start);
        return range;
      }
    }
    return null;
  }

  /** Wrap every text-node piece inside the range in <mark data-fa-hl>. */
  function paintRange(range, id) {
    if (range.collapsed) return [];
    const marks = [];
    const nodes = [];
    const anc = range.commonAncestorContainer;
    if (anc.nodeType === Node.TEXT_NODE) {
      // Selection inside a single text node: the ancestor IS the node, and a
      // TreeWalker never yields its own root.
      nodes.push(anc);
    } else {
      const walker = document.createTreeWalker(anc, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (range.intersectsNode(n) && !SKIP.has(n.parentElement?.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      });
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
    }
    for (const node of nodes) {
      let target = node;
      const s = node === range.startContainer ? range.startOffset : 0;
      const e = node === range.endContainer ? range.endOffset : node.data.length;
      if (e <= s) continue;
      if (e < target.data.length) target.splitText(e);
      if (s > 0) target = target.splitText(s);
      const mark = document.createElement("mark");
      mark.dataset.faHl = id;
      mark.style.cssText = `background:${COLOR};color:inherit;border-radius:2px;cursor:pointer;box-decoration-break:clone;-webkit-box-decoration-break:clone;`;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      marks.push(mark);
    }
    return marks;
  }

  function unpaint(id) {
    for (const m of document.querySelectorAll(`mark[data-fa-hl="${id}"]`)) {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
  }

  /* ================================================================ *
   * Storage
   * ================================================================ */
  let items = []; // [{id, sel, note, question, createdAt}]
  const KEY = pageKey();

  async function load() {
    try {
      const obj = await chrome.storage.local.get(KEY);
      items = obj[KEY] || [];
    } catch {
      items = [];
    }
  }
  async function save() {
    try {
      await chrome.storage.local.set({ [KEY]: items });
    } catch (e) {
      console.warn("[Focus Agent] highlight save failed:", e.message);
    }
  }

  /** Paint any saved highlight that isn't on the page yet (lazy PDFs, SPAs). */
  function reapply() {
    if (!items.length) return;
    const idx = textIndex();
    for (const it of items) {
      if (document.querySelector(`mark[data-fa-hl="${it.id}"]`)) continue;
      const r = selectorToRange(it.sel, idx);
      if (r) paintRange(r, it.id);
    }
  }
  let reapplyTimer = null;
  const scheduleReapply = () => {
    clearTimeout(reapplyTimer);
    reapplyTimer = setTimeout(reapply, 600);
  };

  /* ================================================================ *
   * Brain calls — through the worker (content scripts can't reach the bridge)
   * ================================================================ */
  function coach(method, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "COACH_CALL", method, payload }, (res) => {
          if (chrome.runtime.lastError || !res?.ok) return resolve(null);
          resolve(res.result);
        });
      } catch {
        resolve(null);
      }
    });
  }
  function toThread(text, kind) {
    try {
      chrome.runtime.sendMessage({ type: "THREAD_APPEND", text, kind }, () => void chrome.runtime.lastError);
    } catch {
      /* no worker */
    }
  }

  /** Chrome's on-device Summarizer (Chrome 138+). null when unavailable. */
  async function localSummarize(text) {
    try {
      const S = globalThis.Summarizer;
      if (!S) return null;
      const avail = await S.availability();
      if (avail === "unavailable") return null;
      const summarizer = await Promise.race([
        S.create({ type: "key-points", format: "plain-text", length: text.length > 3000 ? "medium" : "short" }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("model download timeout")), 25000)),
      ]);
      const out = await summarizer.summarize(text.slice(0, 20000));
      summarizer.destroy?.();
      return out ? { summary: out, via: "chrome" } : null;
    } catch (e) {
      console.info("[Focus Agent] built-in summarizer unavailable:", e.message);
      return null;
    }
  }

  /* ================================================================ *
   * UI — one shadow host: the bubble row + a popover
   * ================================================================ */
  const host = document.createElement("div");
  host.id = "fa-sel-host";
  host.style.cssText = "position:absolute;top:0;left:0;z-index:2147483646;width:0;height:0;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .bar {
        position: absolute; display: none; gap: 4px; padding: 5px;
        background: rgba(15, 17, 23, 0.96); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 999px; box-shadow: 0 10px 30px rgba(0,0,0,0.45);
        transform: translate(-50%, calc(-100% - 10px));
        white-space: nowrap;
      }
      .bar.show { display: flex; }
      .bar button {
        background: transparent; border: none; color: #eef0f8; cursor: pointer;
        font-size: 12.5px; padding: 6px 11px; border-radius: 999px; line-height: 1;
      }
      .bar button:hover { background: rgba(255,255,255,0.1); }
      .bar button b { color: #c084fc; margin-right: 4px; }
      .pop {
        position: absolute; display: none; width: 320px; max-width: calc(100vw - 24px);
        background: rgba(15, 17, 23, 0.97); color: #eef0f8; border: 1px solid rgba(129,140,248,0.4);
        border-radius: 14px; box-shadow: 0 14px 40px rgba(0,0,0,0.5); padding: 12px 13px;
        font-size: 13px; line-height: 1.5; transform: translate(-50%, 10px);
      }
      .pop.show { display: block; }
      .pop .label { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #a5b4fc; font-weight: 800; margin-bottom: 6px; }
      .pop .quote { color: #9aa0b4; font-style: italic; font-size: 12px; margin-bottom: 8px; max-height: 60px; overflow: hidden; }
      .pop .body { white-space: pre-wrap; max-height: 260px; overflow-y: auto; }
      .pop .q { color: #fcd34d; margin-bottom: 6px; }
      .pop textarea, .pop input {
        width: 100%; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
        color: #eef0f8; border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 12.5px; outline: none; resize: vertical;
      }
      .pop textarea { min-height: 64px; }
      .pop .row { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; align-items: center; }
      .pop .row .via { margin-right: auto; font-size: 11px; color: #9aa0b4; }
      .pop .row button {
        border: none; border-radius: 999px; padding: 6px 12px; font-size: 12px; cursor: pointer;
        background: rgba(255,255,255,0.1); color: #eef0f8;
      }
      .pop .row button.primary { background: linear-gradient(135deg, #818cf8, #c084fc); color: white; font-weight: 700; }
      .pop .row button.danger:hover { background: rgba(251,113,133,0.35); }
      .typing { display: inline-flex; gap: 4px; padding: 6px 2px; }
      .typing i { width: 6px; height: 6px; border-radius: 50%; background: #9aa0b4; display: block; animation: b 1.1s infinite; }
      .typing i:nth-child(2) { animation-delay: .15s } .typing i:nth-child(3) { animation-delay: .3s }
      @keyframes b { 0%,60%,100% { opacity: .4; transform: none } 30% { opacity: 1; transform: translateY(-4px) } }
    </style>
    <div class="bar" id="bar">
      <button data-act="annotate" title="Highlight + your note (the coach asks, you answer)"><b>🖍</b>annotate</button>
      <button data-act="summarize" title="Summarize just this selection"><b>≡</b>summarize</button>
      <button data-act="ask" title="Ask the coach about this passage"><b>?</b>ask</button>
    </div>
    <div class="pop" id="pop"></div>`;
  (document.body || document.documentElement).appendChild(host);
  const bar = root.getElementById("bar");
  const pop = root.getElementById("pop");

  let pending = null; // { range, sel, rect } for the current selection
  const typing = '<span class="typing"><i></i><i></i><i></i></span>';

  function place(el, rect, below) {
    const x = rect.left + rect.width / 2 + scrollX;
    const y = (below ? rect.bottom : rect.top) + scrollY;
    el.style.left = `${Math.max(170, Math.min(x, scrollX + innerWidth - 170))}px`;
    el.style.top = `${y}px`;
  }
  function hideAll() {
    bar.classList.remove("show");
    pop.classList.remove("show");
  }

  /* ---- selection → bubbles ---- */
  document.addEventListener("mouseup", () => setTimeout(onSelection, 10));
  document.addEventListener("keyup", (e) => {
    if (e.key === "Escape") hideAll();
    else if (e.shiftKey) setTimeout(onSelection, 10);
  });
  document.addEventListener("mousedown", (e) => {
    if (e.composedPath().includes(host)) return;
    pop.classList.remove("show");
  });

  function onSelection() {
    const s = getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) {
      bar.classList.remove("show");
      return;
    }
    const range = s.getRangeAt(0);
    if (host.contains(range.commonAncestorContainer)) return;
    const text = range.toString().trim();
    if (text.length < 3) return;
    const sel = rangeToSelector(range);
    if (!sel) return;
    const rect = range.getBoundingClientRect();
    pending = { range: range.cloneRange(), sel, rect };
    place(bar, rect, false);
    bar.classList.add("show");
  }

  bar.addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (!act || !pending) return;
    bar.classList.remove("show");
    if (act === "annotate") annotate(pending);
    if (act === "summarize") summarize(pending);
    if (act === "ask") ask(pending);
  });

  /* ---- Annotate ---- */
  async function annotate(p) {
    const id = "h" + Date.now().toString(36);
    paintRange(p.range, id);
    getSelection()?.removeAllRanges();
    const item = { id, sel: p.sel, note: "", question: "", createdAt: Date.now() };
    items.push(item);
    await save();
    openNote(item, p.rect, true);
  }

  async function openNote(item, rect, fresh) {
    place(pop, rect, true);
    pop.innerHTML = `
      <div class="label">annotate</div>
      <div class="quote">“${esc(item.sel.exact.slice(0, 180))}${item.sel.exact.length > 180 ? "…" : ""}”</div>
      <div class="q" id="q">${item.question ? esc(item.question) : fresh ? typing : ""}</div>
      <textarea id="note" placeholder="your note — answer the question in your own words">${esc(item.note)}</textarea>
      <div class="row">
        <button class="danger" data-act="remove">remove</button>
        <button class="primary" data-act="save">save</button>
      </div>`;
    pop.classList.add("show");
    const ta = root.getElementById("note");
    ta.focus();

    if (fresh && !item.question) {
      const r = await coach("annotateQuestion", { quote: item.sel.exact.slice(0, 1200), title: pageTitle(), url: location.href });
      item.question = r?.question || "In your own words: what is this passage saying, and why is it here?";
      const q = root.getElementById("q");
      if (q) q.textContent = item.question;
      await save();
    }
    pop.onclick = async (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "save") {
        item.note = ta.value.trim().slice(0, 1000);
        await save();
        if (item.note) toThread(`🖍 “${item.sel.exact.slice(0, 80)}${item.sel.exact.length > 80 ? "…" : ""}”\n${item.note}`, "annotation");
        pop.classList.remove("show");
      } else if (act === "remove") {
        unpaint(item.id);
        items = items.filter((x) => x.id !== item.id);
        await save();
        pop.classList.remove("show");
      }
    };
  }

  // Clicking an existing highlight reopens its note.
  document.addEventListener("click", (e) => {
    const m = e.target.closest?.("mark[data-fa-hl]");
    if (!m) return;
    const item = items.find((x) => x.id === m.dataset.faHl);
    if (!item) return;
    const s = getSelection();
    if (s && !s.isCollapsed) return; // they're selecting, not clicking
    openNote(item, m.getBoundingClientRect(), false);
  });

  /* ---- Summarize ---- */
  async function summarize(p) {
    const text = p.sel.exact;
    place(pop, p.rect, true);
    pop.innerHTML = `<div class="label">summary</div><div class="body" id="body">${typing}</div>
      <div class="row"><span class="via" id="via"></span><button data-act="close">close</button></div>`;
    pop.classList.add("show");
    pop.onclick = (e) => e.target.closest("button")?.dataset.act === "close" && pop.classList.remove("show");

    let r = await localSummarize(text);
    if (!r) {
      const b = await coach("summarize", { text: text.slice(0, 12000), title: pageTitle() });
      r = b?.summary ? { summary: b.summary, via: b.fromClaude ? "claude" : "rules" } : null;
    }
    const body = root.getElementById("body");
    const via = root.getElementById("via");
    if (!body) return;
    if (!r) {
      body.textContent = "Couldn't summarize — the coach is in simple mode right now.";
      return;
    }
    body.textContent = r.summary;
    if (via) via.textContent = r.via === "chrome" ? "on-device (Chrome)" : r.via === "claude" ? "🧠 coach" : "simple mode";
    toThread(`≡ summary of “${text.slice(0, 60)}…”\n${r.summary}`, "summary");
  }

  /* ---- Ask ---- */
  function ask(p) {
    place(pop, p.rect, true);
    pop.innerHTML = `
      <div class="label">ask about this</div>
      <div class="quote">“${esc(p.sel.exact.slice(0, 160))}${p.sel.exact.length > 160 ? "…" : ""}”</div>
      <input id="qin" placeholder="define these words · how does this connect to the thesis · is this a primary source…" />
      <div class="body" id="body" style="margin-top:8px"></div>
      <div class="row"><button data-act="close">close</button><button class="primary" data-act="send">ask</button></div>`;
    pop.classList.add("show");
    const input = root.getElementById("qin");
    input.focus();
    const send = async () => {
      const q = input.value.trim();
      if (!q) return;
      const body = root.getElementById("body");
      body.innerHTML = typing;
      const r = await coach("askPassage", { quote: p.sel.exact.slice(0, 3000), question: q, title: pageTitle(), url: location.href });
      body.textContent = r?.reply || "The coach is in simple mode right now — try again in a minute.";
      if (r?.reply) toThread(`? “${p.sel.exact.slice(0, 60)}…” — ${q}\n${r.reply}`, "ask");
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && send());
    pop.onclick = (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "send") send();
      if (act === "close") pop.classList.remove("show");
    };
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ================================================================ *
   * Boot: restore highlights, keep them alive through re-renders
   * ================================================================ */
  load().then(() => {
    reapply();
    new MutationObserver((muts) => {
      if (muts.some((m) => m.addedNodes.length && ![...m.addedNodes].every((n) => host.contains(n) || n.nodeName === "MARK"))) scheduleReapply();
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
