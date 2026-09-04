/**
 * lib/pdftext.js - Extract text from a PDF inside the extension (side panel),
 * using the pdf.js build we already ship for the viewer. Loaded lazily via
 * dynamic import so the panel doesn't pay for pdf.js until a PDF is attached.
 *
 *   FA.pdfText.fromUrl(url, {maxPages, maxChars})  → { text, pages, truncated }
 *   FA.pdfText.fromData(arrayBuffer, opts)          → same
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

  async function extract(getDocumentArg, { maxPages = 60, maxChars = 120000 } = {}) {
    const pdfjs = await lib();
    const doc = await pdfjs.getDocument(getDocumentArg).promise;
    const n = Math.min(doc.numPages, maxPages);
    let text = "";
    for (let i = 1; i <= n && text.length < maxChars; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Join items; pdf.js marks line ends with hasEOL.
      let line = "";
      for (const it of content.items) {
        line += it.str;
        if (it.hasEOL) {
          text += line.trimEnd() + "\n";
          line = "";
        } else if (it.str && !it.str.endsWith(" ")) line += " ";
      }
      text += line + "\n\n";
    }
    return { text: text.slice(0, maxChars), pages: doc.numPages, truncated: doc.numPages > n || text.length > maxChars };
  }

  FA.pdfText = {
    async fromUrl(url, opts) {
      // Fetch ourselves (host permission) so pdf.js never hits a CORS wall.
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`PDF fetch ${res.status}`);
      return extract({ data: new Uint8Array(await res.arrayBuffer()) }, opts);
    },
    async fromData(buf, opts) {
      return extract({ data: new Uint8Array(buf) }, opts);
    },
  };
})();
