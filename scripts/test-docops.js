/**
 * scripts/test-docops.js - Unit tests for lib/docops.js (plain node, no deps).
 * Run: node scripts/test-docops.js
 */
const path = require("path");
globalThis.FA = {};
require(path.join(__dirname, "..", "lib", "docops.js"));
const { formatRequests, editRequests, paragraphsOf, outline } = FA.docOps;

// A fake documents.get body: 4 paragraphs. Indexes as Docs would report them.
function fakeDoc(lines) {
  let idx = 1;
  const content = lines.map((t) => {
    const el = { startIndex: idx, endIndex: idx + t.length + 1, paragraph: { elements: [{ textRun: { content: t + "\n" } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } };
    idx = el.endIndex;
    return el;
  });
  return { body: { content } };
}

const results = [];
const check = (n, ok, x = "") => results.push(`${ok ? "✓" : "✗"} ${n}${x ? " — " + x : ""}`);
const doc = fakeDoc(["Columbus Essay", "Intro paragraph here.", "- first point", "Body paragraph two."]);
const paras = paragraphsOf(doc);
check("paragraphsOf keeps indexes", paras.length === 4 && paras[0].startIndex === 1 && paras[3].endIndex === 1 + "Columbus Essay".length + 1 + "Intro paragraph here.".length + 1 + "- first point".length + 1 + "Body paragraph two.".length + 1);

// ---- formatting never changes words (except bullet markers) ----
const mla = formatRequests(doc, "mla");
const types = (rs) => rs.map((r) => Object.keys(r)[0]);
check("MLA: margins, font, spacing first", types(mla).slice(0, 3).join(",") === "updateDocumentStyle,updateTextStyle,updateParagraphStyle");
check("MLA: no insertText, no replaceAll", !types(mla).includes("insertText") && !types(mla).includes("replaceAllText"));
const centered = mla.find((r) => r.updateParagraphStyle?.paragraphStyle?.alignment === "CENTER");
check("MLA: title centered", centered && centered.updateParagraphStyle.range.startIndex === 1);
const bullet = mla.find((r) => r.createParagraphBullets);
const marker = mla.find((r) => r.deleteContentRange);
check("bullet marker becomes a real bullet, marker deleted", bullet && marker && marker.deleteContentRange.range.startIndex === paras[2].startIndex && marker.deleteContentRange.range.endIndex === paras[2].startIndex + 2);
const perPara = mla.slice(3);
const idxs = perPara.map((r) => (r.updateParagraphStyle || r.createParagraphBullets || r.deleteContentRange).range.startIndex);
check("per-paragraph ops run last-to-first", idxs.every((v, i) => i === 0 || v <= idxs[i - 1]), idxs.join(","));
const clean = formatRequests(fakeDoc(["My Notes", "## Causes", "Long sentence that ends with a period.", "- a bullet"]), "clean");
const heading = clean.find((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_2");
check("clean: '## Causes' → HEADING_2 and hashes removed", heading && clean.some((r) => r.deleteContentRange && r.deleteContentRange.range.endIndex - r.deleteContentRange.range.startIndex === 3));
check("clean: first line → TITLE", clean.some((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "TITLE"));
check("empty doc → no requests", formatRequests({ body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [{ textRun: { content: "\n" } }] } }] } }).length === 0);

// ---- editing ----
const e1 = editRequests(doc, [{ type: "replaceAll", find: "Columbus", replace: "Cristóbal Colón" }]);
check("replaceAll → replaceAllText", e1.length === 1 && e1[0].replaceAllText.replaceText === "Cristóbal Colón");

const e2 = editRequests(doc, [{ type: "insertAfter", paragraph: 3, text: "Conclusion." }, { type: "insertAfter", paragraph: 1, text: "Thesis sentence." }]);
check("insertAfter last paragraph inserts before final newline", e2[0].insertText.location.index === paras[3].endIndex - 1 && e2[0].insertText.text === "\nConclusion.");
check("index ops sorted last-to-first", e2[0].insertText.location.index > e2[1].insertText.location.index);

const e3 = editRequests(doc, [{ type: "replaceParagraph", paragraph: 1, text: "A better intro." }]);
check("replaceParagraph deletes text but keeps its newline", e3[0].deleteContentRange.range.endIndex === paras[1].endIndex - 1 && e3[1].insertText.location.index === paras[1].startIndex);

const e4 = editRequests(doc, [{ type: "deleteParagraph", paragraph: 3 }]);
check("deleteParagraph on last paragraph never touches the final newline", e4[0].deleteContentRange.range.endIndex === paras[3].endIndex - 1);

const e5 = editRequests(doc, [{ type: "replaceBody", text: "Fresh start." }, { type: "replaceAll", find: "x", replace: "y" }]);
check("replaceBody is exclusive: delete [1,end-1) then insert at 1", e5.length === 2 && e5[0].deleteContentRange.range.startIndex === 1 && e5[1].insertText.text === "Fresh start.\n");

const e6 = editRequests(doc, [{ type: "setStyle", paragraph: 99, style: "HEADING_1" }, { type: "append", text: "The end." }]);
check("out-of-range paragraph ignored; append lands before final newline", e6.length === 1 && e6[0].insertText.location.index === paras[3].endIndex - 1);

check("outline gives the brain numbered paragraphs", outline(doc)[2].i === 2 && outline(doc)[2].text === "- first point");

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("✗")).length;
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
