/**
 * lib/pdftext.js - Extract readable text from a PDF inside the extension,
 * using the pdf.js build we ship for the viewer (lazy dynamic import).
 *
 *   FA.pdfText.fromUrl(url, opts)     → { text, pages, pageChars, truncated, bytes }  (fetched by the worker: Drive-aware)
 *   FA.pdfText.fromData(buffer, opts) → same
 *   FA.fetchPdfBytes(url)             → Uint8Array (worker FETCH_PDF)
 *   FA.pdfPages.render(bytes, [n…])   → [{ page, dataUrl }]  JPEGs of chosen pages, for the coach's eyes
 *
 * pageChars (chars of text layer per page) is how the panel finds the pages
 * the text layer can't explain — scans, figures, worksheets — and sends
 * those, and only those, as images (spec §11.1).
 *
 * Text is rebuilt into paragraphs: lines on a page are joined with spaces,
 * a vertical gap bigger than ~1.6 lines starts a new paragraph, "word-" at a
 * line end is de-hyphenated, and pages are separated by a blank line — so
 * the coach reads prose, not a ransom note of line breaks.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});
  let libPromise = null;

  async function lib() {
    if (!libPromise) {
      libPromise = import(chrome.runtime.getURL("viewer/pdfjs/build/pdf.mjs")).then((m) => {
        m.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("viewer/pdfjs/build/pdf.worker.mjs");
        return m;
      });
    }
    return libPromise;
  }

  FA.fetchPdfBytes = function fetchPdfBytes(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "FETCH_PDF", url }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) return reject(new Error(res?.error || "fetch failed"));
        const bin = atob(res.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(bytes);
      });
    });
  };

  /** Turn one page's text items into paragraphs using their positions. */
  function pageToParagraphs(items) {
    const lines = [];
    let cur = null;
    for (const it of items) {
      if (!it.str && !it.hasEOL) continue;
      const y = Math.round(it.transform?.[5] ?? 0);
      const h = it.height || Math.abs(it.transform?.[3] || 10) || 10;
      if (!cur || Math.abs(y - cur.y) > h * 0.5) {
        cur = { y, h, text: "" };
        lines.push(cur);
      }
      cur.text += it.str;
      if (it.str && !it.str.endsWith(" ") && !it.hasEOL) cur.text += " ";
    }
    const paras = [];
    let para = "";
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i].text.replace(/\s+/g, " ").trim();
      if (!ln) continue;
      const prev = lines[i - 1];
      const gap = prev ? Math.abs(prev.y - lines[i].y) : 0;
      const newPara = prev && gap > Math.max(prev.h, lines[i].h) * 1.6;
      if (newPara && para) {
        paras.push(para.trim());
        para = "";
      }
      if (/\w-$/.test(para)) para = para.slice(0, -1) + ln; // de-hyphenate
      else para += (para ? " " : "") + ln;
    }
    if (para.trim()) paras.push(para.trim());
    return paras;
  }

  async function extract(getDocumentArg, { maxPages = 80, maxChars = 200000 } = {}) {
    const pdfjs = await lib();
    const doc = await pdfjs.getDocument(getDocumentArg).promise;
    const n = Math.min(doc.numPages, maxPages);
    const chunks = [];
    const pageChars = [];
    let total = 0;
    for (let i = 1; i <= n && total < maxChars; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const paras = pageToParagraphs(content.items);
      // Drop running headers/footers that are just a page number.
      const kept = paras.filter((p) => !/^\d{1,4}$/.test(p));
      const pageText = kept.join("\n\n");
      chunks.push(pageText);
      pageChars.push(pageText.length);
      total += pageText.length + 2;
    }
    const text = chunks.join("\n\n").slice(0, maxChars);
    return { text, pages: doc.numPages, pageChars, truncated: doc.numPages > n || total > maxChars };
  }

  FA.pdfText = {
    async fromUrl(url, opts) {
      const bytes = await FA.fetchPdfBytes(url);
      // pdf.js transfers the buffer to its worker; extract from a copy so the
      // caller can still render pages from `bytes` afterwards.
      return { ...(await extract({ data: bytes.slice() }, opts)), bytes };
    },
    async fromData(buf, opts) {
      const bytes = new Uint8Array(buf);
      return { ...(await extract({ data: bytes.slice() }, opts)), bytes };
    },
  };

  FA.pdfPages = {
    /**
     * Render the given 1-based pages to JPEG data URLs (longest side maxSide).
     * White background so transparent scans don't come out black.
     */
    async render(bytes, pageNumbers, { maxSide = 1400, quality = 0.8 } = {}) {
      const pdfjs = await lib();
      const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      const out = [];
      for (const n of pageNumbers) {
        if (n < 1 || n > doc.numPages) continue;
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(3, maxSide / Math.max(base.width, base.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(vp.width));
        c.height = Math.max(1, Math.round(vp.height));
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        out.push({ page: n, dataUrl: c.toDataURL("image/jpeg", quality) });
      }
      return out;
    },
  };
})();
