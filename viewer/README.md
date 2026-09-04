# viewer/

`pdfjs/` is Mozilla's pdf.js **v4.10.38** generic build (Apache-2.0, see `pdfjs/LICENSE`), trimmed:
source maps, the debugger, the sample PDF and every locale except en-US were dropped (18 MB → ~7 MB).

Two local edits, both marked with `Focus Agent:` comments:
- `web/viewer.mjs` — the same-origin `validateFileURL` check is disabled so the viewer, which runs as an
  extension page, can open PDFs from any origin the student granted (`optional_host_permissions`).
- `web/viewer.html` — loads `annotate/selection-toolbar.js` so highlight → Annotate · Summarize · Ask
  works on PDFs exactly like on web pages (Chrome's built-in PDF viewer can't be injected into).

Open a PDF with: `chrome-extension://<id>/viewer/pdfjs/web/viewer.html?file=<encoded url>` — the panel's
`openTab()` does this automatically for `.pdf` links.

To upgrade: download the new `pdfjs-<ver>-dist.zip`, copy `build/{pdf,pdf.worker,pdf.sandbox}.mjs`,
`web/{viewer.html,viewer.css,viewer.mjs,images,cmaps,standard_fonts,locale/en-US,locale/locale.json}`,
then re-apply the two edits above.
