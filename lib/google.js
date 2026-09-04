/**
 * lib/google.js - Google Docs / Drive / Calendar client for the extension.
 *
 * Auth: chrome.identity.getAuthToken() with the oauth2 block in manifest.json.
 * The user approves once; Chrome caches the token. Nothing here stores
 * tokens or credentials itself.
 *
 * Scopes (manifest):
 *   drive.file        files this app created or the user opened with it
 *   documents         read/write Google Docs by id (needed to read a doc the
 *                     student pastes a link to; sensitive scope — fine while
 *                     the OAuth app is in Testing mode, revisit before public)
 *   calendar.events   create/update events (focus blocks, deadline reminders)
 *
 * Runs in extension pages (side panel, popup, worker) — NOT in content scripts,
 * which can't use chrome.identity.
 *
 * Product rule enforced here: we WRITE COMMENTS, never body text, on the
 * student's own work. The only body writes are formatting/outline into docs
 * this app created (Doc Starter).
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  const DOCS = "https://docs.googleapis.com/v1";
  const DRIVE = "https://www.googleapis.com/drive/v3";
  const CAL = "https://www.googleapis.com/calendar/v3";

  /* ------------------------------------------------------------------ *
   * Auth
   * ------------------------------------------------------------------ */
  function getToken(interactive) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(new Error(chrome.runtime.lastError?.message || "no token"));
        } else {
          resolve(token);
        }
      });
    });
  }

  async function api(url, { method = "GET", body, token, retry = true } = {}) {
    token = token || (await getToken(false).catch(() => getToken(true)));
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) {
      // Token expired/revoked: drop it from Chrome's cache and try once more.
      await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
      return api(url, { method, body, retry: false });
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).error?.message || "";
      } catch {}
      throw new Error(`Google ${res.status}${detail ? ": " + detail : ""}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /** Turn the mobilebasic HTML into { title, text, paragraphs }. */
  function parseMobileBasic(html) {
    const dom = new DOMParser().parseFromString(html, "text/html");
    dom.querySelectorAll("script, style, noscript").forEach((n) => n.remove());
    const title = (dom.querySelector("title")?.textContent || "").replace(/ - Google Docs$/, "").trim();
    const root = dom.querySelector(".doc-content") || dom.body;
    const blocks = root.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, tr");
    const paragraphs = [];
    let text = "";
    const push = (t, style) => {
      const clean = t.replace(/\s+/g, " ").trim();
      if (!clean) return;
      paragraphs.push({ start: text.length, end: text.length + clean.length + 1, text: clean, style });
      text += clean + "\n";
    };
    if (blocks.length) {
      blocks.forEach((el) => {
        if (el.tagName === "TR") {
          push(Array.from(el.querySelectorAll("td, th")).map((c) => c.textContent).join(" | "), "TABLE_ROW");
        } else {
          push(el.textContent, el.tagName.startsWith("H") ? "HEADING" : "NORMAL_TEXT");
        }
      });
    } else {
      (root.textContent || "").split(/\n+/).forEach((line) => push(line, "NORMAL_TEXT"));
    }
    return { title, text, paragraphs };
  }

  FA.google = {
    /** Prompt the user to connect Google (interactive). Returns true on success. */
    async connect() {
      await getToken(true);
      return true;
    },

    /** True if a cached token exists (no prompt). */
    async isConnected() {
      try {
        await getToken(false);
        return true;
      } catch {
        return false;
      }
    },

    /** Forget the token (user-initiated disconnect). */
    async disconnect() {
      try {
        const token = await getToken(false);
        await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
        await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
      } catch {}
    },

    /* ---------------------------------------------------------------- *
     * Docs: read
     * ---------------------------------------------------------------- */

    /** Extract a document id from any Docs URL or return the input if it's already an id. */
    docIdFrom(urlOrId) {
      const m = String(urlOrId || "").match(/\/document\/d\/([\w-]{20,})/);
      return m ? m[1] : String(urlOrId || "").trim();
    },

    /**
     * Read a doc as plain text with paragraph offsets, so feedback can be
     * anchored to exact positions later.
     *   → { id, title, text, paragraphs: [{ start, end, text, style }] }
     */
    async readDoc(urlOrId) {
      const id = this.docIdFrom(urlOrId);

      // Route 0 — no OAuth: the "mobile basic" view is server-rendered HTML of
      // the whole doc, served with the browser's own login cookies. Works for
      // any doc the Chrome profile can VIEW, even when the owner has disabled
      // download/export (common for teacher handouts). Verified live 2026-08-29.
      try {
        const res = await fetch(`https://docs.google.com/document/d/${id}/mobilebasic`, {
          credentials: "include",
          redirect: "follow",
        });
        if (res.ok && /text\/html/.test(res.headers.get("content-type") || "")) {
          const html = await res.text();
          const parsed = parseMobileBasic(html);
          if (parsed.text.trim().length > 0) return { id, ...parsed, revisionId: null, via: "mobilebasic" };
        }
      } catch {
        /* fall through */
      }

      // Route 1 — export as plain text (fails when download is disabled).
      try {
        const res = await fetch(`https://docs.google.com/document/d/${id}/export?format=txt`, {
          credentials: "include",
          redirect: "follow",
        });
        const ct = res.headers.get("content-type") || "";
        if (res.ok && /text\/plain/.test(ct)) {
          const raw = (await res.text()).replace(/^\uFEFF/, "");
          const paras = raw.split(/\r?\n/);
          let pos = 0;
          const paragraphs = paras
            .map((t) => {
              const start = pos;
              pos += t.length + 1;
              return { start, end: pos, text: t, style: "NORMAL_TEXT" };
            })
            .filter((pp) => pp.text.trim());
          return { id, title: "", text: raw, paragraphs, revisionId: null, via: "export" };
        }
      } catch {
        /* fall through to the API */
      }

      // Route 2 — Docs API (needs Google connected; gives title + structure).
      const doc = await api(`${DOCS}/documents/${id}`);
      const paragraphs = [];
      let text = "";
      for (const el of doc.body?.content || []) {
        const p = el.paragraph;
        if (!p) continue;
        const runs = (p.elements || []).map((e) => e.textRun?.content || "").join("");
        if (!runs) continue;
        paragraphs.push({
          start: el.startIndex,
          end: el.endIndex,
          text: runs.replace(/\n$/, ""),
          style: p.paragraphStyle?.namedStyleType || "NORMAL_TEXT",
        });
        text += runs;
      }
      return { id, title: doc.title || "", text, paragraphs, revisionId: doc.revisionId, via: "api" };
    },

    /* ---------------------------------------------------------------- *
     * Docs: comments (Drive API) — the "annotate homework" primitive.
     * A comment anchored to a quoted passage is exactly what a tutor's
     * margin note is; it never changes the student's words.
     * ---------------------------------------------------------------- */

    /** Add one comment. `quote` is the exact text the comment is about (optional). */
    async addComment(docId, content, quote = "") {
      const body = { content };
      if (quote) body.quotedFileContent = { mimeType: "text/plain", value: quote };
      return api(`${DRIVE}/files/${docId}/comments?fields=id,content,quotedFileContent`, {
        method: "POST",
        body,
      });
    },

    /**
     * Post a Pre-check result as comments: one per issue (quoted), plus a
     * summary comment. Returns the number of comments written.
     */
    async postPrecheckComments(docId, result) {
      let n = 0;
      for (const issue of result.issues || []) {
        const text = `${issue.problem}\n→ ${issue.hint}`;
        await this.addComment(docId, text, issue.quote || "");
        n++;
      }
      const summary = [
        `Focus Agent pre-check — estimate: ${result.grade}`,
        result.strengths?.length ? `Working: ${result.strengths.join("; ")}` : "",
        result.missing?.length ? `Not addressed yet: ${result.missing.join("; ")}` : "",
        result.nextStep ? `Next: ${result.nextStep}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await this.addComment(docId, summary);
      return n + 1;
    },

    /* ---------------------------------------------------------------- *
     * Docs: create + format (Doc Starter, upgraded)
     * ---------------------------------------------------------------- */

    /**
     * Create a titled doc with a heading + outline skeleton. Only ever runs
     * on a doc this app creates. Returns { id, url }.
     */
    async createOutlineDoc(title, subtitle, steps) {
      const doc = await api(`${DOCS}/documents`, { method: "POST", body: { title } });
      const id = doc.documentId;

      // Build the text first, then style ranges. Docs indexes are 1-based
      // after the initial section break.
      const lines = [title, subtitle, "", ...steps.map((s, i) => `${i + 1}. ${s}`), ""];
      const text = lines.join("\n");
      const requests = [{ insertText: { location: { index: 1 }, text } }];

      let idx = 1;
      const styleLine = (line, namedStyle) => {
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: idx, endIndex: idx + line.length + 1 },
            paragraphStyle: { namedStyleType: namedStyle },
            fields: "namedStyleType",
          },
        });
      };
      styleLine(lines[0], "TITLE");
      idx += lines[0].length + 1;
      styleLine(lines[1], "SUBTITLE");

      await api(`${DOCS}/documents/${id}:batchUpdate`, { method: "POST", body: { requests } });
      return { id, url: `https://docs.google.com/document/d/${id}/edit` };
    },

    /* ---------------------------------------------------------------- *
     * Calendar: focus blocks + deadline reminders → phone notifications
     * ---------------------------------------------------------------- */

    /** Create an event with a popup reminder. `minutesBefore` default 10. */
    async addEvent({ title, description = "", start, end, minutesBefore = 10 }) {
      return api(`${CAL}/calendars/primary/events`, {
        method: "POST",
        body: {
          summary: title,
          description,
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(end).toISOString() },
          reminders: { useDefault: false, overrides: [{ method: "popup", minutes: minutesBefore }] },
          extendedProperties: { private: { focusAgent: "1" } },
        },
      });
    },

    /** Write a panic plan's blocks to the calendar. Returns created events. */
    async addPlanBlocks(blocks, day = new Date()) {
      const out = [];
      for (const b of blocks) {
        const [sh, sm] = b.start.split(/[:\s]/).map(Number);
        const [eh, em] = b.end.split(/[:\s]/).map(Number);
        const s = new Date(day);
        s.setHours(sh + (/pm/i.test(b.start) && sh < 12 ? 12 : 0), sm || 0, 0, 0);
        const e = new Date(day);
        e.setHours(eh + (/pm/i.test(b.end) && eh < 12 ? 12 : 0), em || 0, 0, 0);
        out.push(await this.addEvent({ title: `📚 ${b.title}`, description: b.note || "", start: s, end: e, minutesBefore: 5 }));
      }
      return out;
    },
  };
})();
