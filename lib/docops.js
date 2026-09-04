/**
 * lib/docops.js - Pure translators from "what to do to a doc" into Google
 * Docs API batchUpdate requests. No network, no chrome.* — so it's unit-
 * testable in plain node (scripts/test-docops.js) and the risky part
 * (index arithmetic) lives in one place.
 *
 * Two entry points:
 *   FA.docOps.formatRequests(doc, preset)   formatting only — the student build.
 *                                            Never changes the words.
 *   FA.docOps.editRequests(doc, ops)        write anything anywhere — Ben's build.
 *                                            Ops come from the coach brain.
 *
 * `doc` is the documents.get JSON. Docs indexes: body content starts at 1;
 * every paragraph ends with a newline that belongs to it; the very last
 * newline of the body can never be deleted or written past.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  /** Flatten the body into paragraphs we can reason about. */
  function paragraphsOf(doc) {
    const out = [];
    for (const el of doc?.body?.content || []) {
      if (!el.paragraph) continue;
      const text = (el.paragraph.elements || []).map((e) => e.textRun?.content || "").join("");
      out.push({
        startIndex: el.startIndex,
        endIndex: el.endIndex,
        text: text.replace(/\n$/, ""),
        style: el.paragraph.paragraphStyle?.namedStyleType || "NORMAL_TEXT",
        hasBullet: Boolean(el.paragraph.bullet),
      });
    }
    return out;
  }

  const bodyEnd = (doc) => {
    const c = doc?.body?.content || [];
    return c.length ? c[c.length - 1].endIndex : 2;
  };

  const pt = (magnitude) => ({ magnitude, unit: "PT" });

  const PRESETS = {
    // MLA: Times New Roman 12, double-spaced, 1" margins, first line indented.
    mla: { font: "Times New Roman", size: 12, lineSpacing: 200, margin: 72, firstLineIndent: 36, centerFirst: true, detectHeadings: false },
    // Clean notes/outline: Arial 11, 1.15 spacing, headings + bullets detected.
    clean: { font: "Arial", size: 11, lineSpacing: 115, margin: 72, firstLineIndent: 0, centerFirst: false, detectHeadings: true },
  };

  /** A short line with no sentence-ending punctuation reads as a heading. */
  function looksLikeHeading(text) {
    const t = text.trim();
    if (!t || t.length > 70) return false;
    if (/[.!?,;]$/.test(t)) return false;
    const words = t.split(/\s+/);
    return words.length <= 8 && (/^#+\s/.test(t) || /^[A-Z0-9]/.test(t));
  }
  const looksLikeBullet = (text) => /^\s*([-*•]|\d+[.)])\s+/.test(text);

  /**
   * Formatting only. Returns batchUpdate requests that restyle the doc without
   * touching a single word (bullet markers like "- " are the one exception:
   * they become real bullets, and the marker text is removed).
   */
  function formatRequests(doc, presetName = "mla") {
    const p = PRESETS[presetName] || PRESETS.mla;
    const paras = paragraphsOf(doc);
    const end = bodyEnd(doc);
    if (end <= 2) return [];
    const req = [];

    req.push({
      updateDocumentStyle: {
        documentStyle: { marginTop: pt(p.margin), marginBottom: pt(p.margin), marginLeft: pt(p.margin), marginRight: pt(p.margin) },
        fields: "marginTop,marginBottom,marginLeft,marginRight",
      },
    });
    req.push({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: end - 1 },
        textStyle: { weightedFontFamily: { fontFamily: p.font }, fontSize: pt(p.size) },
        fields: "weightedFontFamily,fontSize",
      },
    });
    req.push({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: end - 1 },
        paragraphStyle: { lineSpacing: p.lineSpacing, spaceAbove: pt(0), spaceBelow: pt(0) },
        fields: "lineSpacing,spaceAbove,spaceBelow",
      },
    });

    // Per-paragraph decisions, processed LAST-TO-FIRST so bullet-marker
    // deletions never shift the indexes of paragraphs we still have to touch.
    const perPara = [];
    paras.forEach((para, i) => {
      const range = { startIndex: para.startIndex, endIndex: para.endIndex };
      if (!para.text.trim()) return;
      if (i === 0) {
        perPara.push({
          updateParagraphStyle: {
            range,
            paragraphStyle: p.centerFirst ? { alignment: "CENTER", indentFirstLine: pt(0), namedStyleType: "NORMAL_TEXT" } : { namedStyleType: "TITLE" },
            fields: p.centerFirst ? "alignment,indentFirstLine,namedStyleType" : "namedStyleType",
          },
        });
        return;
      }
      if (looksLikeBullet(para.text) && !para.hasBullet) {
        const marker = para.text.match(/^\s*([-*•]|\d+[.)])\s+/)[0];
        const numbered = /^\s*\d/.test(marker);
        perPara.push({ createParagraphBullets: { range, bulletPreset: numbered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE" } });
        perPara.push({ deleteContentRange: { range: { startIndex: para.startIndex, endIndex: para.startIndex + marker.length } } });
        return;
      }
      if (p.detectHeadings && looksLikeHeading(para.text) && !para.hasBullet) {
        const hashes = para.text.match(/^#+/)?.[0].length || 0;
        perPara.push({
          updateParagraphStyle: { range, paragraphStyle: { namedStyleType: hashes >= 3 ? "HEADING_3" : hashes === 2 ? "HEADING_2" : "HEADING_2" }, fields: "namedStyleType" },
        });
        if (hashes) perPara.push({ deleteContentRange: { range: { startIndex: para.startIndex, endIndex: para.startIndex + hashes + 1 } } });
        return;
      }
      if (p.firstLineIndent && !para.hasBullet) {
        perPara.push({
          updateParagraphStyle: { range, paragraphStyle: { indentFirstLine: pt(p.firstLineIndent), namedStyleType: "NORMAL_TEXT" }, fields: "indentFirstLine,namedStyleType" },
        });
      }
    });
    // Reverse document order: later paragraphs first.
    perPara.reverse();
    return req.concat(perPara);
  }

  /**
   * Write anything anywhere (developer mode). Ops:
   *   {type:"replaceAll", find, replace, matchCase?}         index-free, safe
   *   {type:"setStyle", paragraph, style}                    HEADING_1… / NORMAL_TEXT / TITLE
   *   {type:"insertAfter", paragraph, text}                  new paragraph(s) after #paragraph
   *   {type:"replaceParagraph", paragraph, text}             swap the words of one paragraph
   *   {type:"deleteParagraph", paragraph}
   *   {type:"append", text}                                  at the very end
   *   {type:"replaceBody", text}                             wipe and rewrite (exclusive)
   * `paragraph` is a 0-based index into paragraphsOf(doc). Index-based ops run
   * last-to-first so earlier indexes stay valid; replaceAll runs first.
   */
  function editRequests(doc, ops) {
    const paras = paragraphsOf(doc);
    const end = bodyEnd(doc);
    const list = (Array.isArray(ops) ? ops : []).filter(Boolean);

    const body = list.find((o) => o.type === "replaceBody");
    if (body) {
      const req = [];
      if (end - 1 > 1) req.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } });
      req.push({ insertText: { location: { index: 1 }, text: String(body.text || "").replace(/\n?$/, "\n") } });
      return req;
    }

    const req = [];
    for (const o of list.filter((x) => x.type === "replaceAll")) {
      if (!o.find) continue;
      req.push({ replaceAllText: { containsText: { text: String(o.find), matchCase: o.matchCase !== false }, replaceText: String(o.replace ?? "") } });
    }

    const indexed = list
      .filter((x) => x.type !== "replaceAll" && x.type !== "append")
      .map((o) => ({ ...o, paragraph: Number(o.paragraph) }))
      .filter((o) => Number.isInteger(o.paragraph) && paras[o.paragraph])
      .sort((a, b) => b.paragraph - a.paragraph);

    for (const o of indexed) {
      const para = paras[o.paragraph];
      const isLast = para.endIndex >= end;
      const range = { startIndex: para.startIndex, endIndex: isLast ? para.endIndex - 1 : para.endIndex };
      switch (o.type) {
        case "setStyle":
          req.push({ updateParagraphStyle: { range: { startIndex: para.startIndex, endIndex: para.endIndex }, paragraphStyle: { namedStyleType: String(o.style || "NORMAL_TEXT") }, fields: "namedStyleType" } });
          break;
        case "insertAfter":
          // Insert just before this paragraph's trailing newline: "\n" + text
          // becomes a fresh paragraph right after it, even when it's the last one.
          req.push({ insertText: { location: { index: para.endIndex - 1 }, text: "\n" + String(o.text || "").replace(/\n$/, "") } });
          break;
        case "replaceParagraph": {
          const textEnd = para.endIndex - 1; // keep the paragraph's own newline
          if (textEnd > para.startIndex) req.push({ deleteContentRange: { range: { startIndex: para.startIndex, endIndex: textEnd } } });
          req.push({ insertText: { location: { index: para.startIndex }, text: String(o.text || "").replace(/\n$/, "") } });
          break;
        }
        case "deleteParagraph":
          if (range.endIndex > range.startIndex) req.push({ deleteContentRange: { range } });
          break;
      }
    }

    for (const o of list.filter((x) => x.type === "append")) {
      req.push({ insertText: { location: { index: end - 1 }, text: "\n" + String(o.text || "").replace(/\n$/, "") } });
    }
    return req;
  }

  /** Paragraphs with indexes, for the brain to reference in ops. */
  function outline(doc) {
    return paragraphsOf(doc).map((p, i) => ({ i, style: p.style, text: p.text.slice(0, 200) }));
  }

  FA.docOps = { paragraphsOf, formatRequests, editRequests, outline, PRESETS };
})();
