/**
 * lib/google.js - Google Docs / Drive / Calendar client for the extension.
 *
 * Auth: chrome.identity.getAuthToken() with the oauth2 block in manifest.json.
 * Chrome caches its tokens; the web fallback stores a short-lived access token
 * locally. Shared display status is stored separately and contains no tokens.
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
   * Auth — two doors, same token.
   *
   * 1. chrome.identity.getAuthToken: uses the account Chrome itself is
   *    signed into. Fast, silent refresh. BUT Poly's Workspace blocks
   *    third-party OAuth for students ("Service has been disabled for this
   *    account"), so on the school profile this door is locked.
   * 2. chrome.identity.launchWebAuthFlow with a *Web application* client:
   *    opens Google's own account chooser, so the student can pick a
   *    personal Gmail regardless of which account Chrome is signed into.
   *    Implicit grant → access token (~1h); renewed silently with
   *    prompt=none while the Google session cookie lasts.
   *
   * Scopes come from the manifest's oauth2 block either way.
   * ------------------------------------------------------------------ */
  // Web-application OAuth client for door 2 (project focus-agent-507019, created
// 2026-09-04; redirect https://bobgaegfmhloffjkpjjaeohoimcpfame.chromiumapp.org/).
// Client IDs are public identifiers, not secrets; the client secret is NOT used
// (implicit grant) and is not stored anywhere in this repo.
const WEB_CLIENT_ID = "248896287493-4640r61qu86tcfqabid7v8mcbdk56kjm.apps.googleusercontent.com";
  const WEB_TOKEN_KEY = "googleWebToken";
  const AUTH_STATE_KEY = "googleAuthState";
  const emptyState = () => ({ version: 1, status: "disconnected", selectedDoor: null, everConnected: false, reason: null });
  const categories = new Set(["authorization", "policy_disabled", "cancelled", "network", "configuration", "resource", "unknown"]);
  function authError(category, door, attempts) {
    const error = new Error(`Google ${category}`);
    error.category = category;
    error.door = door;
    if (attempts) error.attempts = attempts;
    return error;
  }
  function identityError(message, door) {
    const text = String(message || "");
    const category = /^Service has been disabled for this account\.?$/i.test(text) ? "policy_disabled"
      : /cancel|closed|did not approve|access_denied/i.test(text) ? "cancelled"
      : /network|offline|connection|timed? ?out/i.test(text) ? "network"
      : /invalid_client|bad client|redirect_uri|manifest|client.?id/i.test(text) ? "configuration"
      : /not signed in|OAuth2 not granted|login_required|interaction_required|consent_required|invalid_grant/i.test(text) ? "authorization" : "unknown";
    return authError(category, door);
  }
  async function status() {
    const saved = await chrome.storage.local.get([AUTH_STATE_KEY, WEB_TOKEN_KEY]);
    const state = saved[AUTH_STATE_KEY];
    if (state?.version === 1) return {
      version: 1, status: ["connected", "reconnect"].includes(state.status) ? state.status : "disconnected",
      selectedDoor: ["chrome", "web"].includes(state.selectedDoor) ? state.selectedDoor : null,
      everConnected: Boolean(state.everConnected), reason: categories.has(state.reason) ? state.reason : null,
    };
    // Legacy credentials preserve account intent, but token presence isn't proof of validity.
    return saved[WEB_TOKEN_KEY]?.access_token ? { ...emptyState(), selectedDoor: "web", everConnected: true } : emptyState();
  }
  async function rememberConnection(credential) {
    await chrome.storage.local.set({ [AUTH_STATE_KEY]: { version: 1, status: "connected", selectedDoor: credential.door, everConnected: true, reason: null } });
    return credential;
  }

  const scopes = () => (chrome.runtime.getManifest().oauth2?.scopes || []).join(" ");

  function getChromeToken(interactive) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError || !token) reject(identityError(chrome.runtime.lastError?.message, "chrome"));
        else resolve({ token, door: "chrome" });
      });
    });
  }

  async function getWebToken(interactive) {
    if (!WEB_CLIENT_ID) throw new Error("no web client configured");
    const { [WEB_TOKEN_KEY]: saved } = await chrome.storage.local.get(WEB_TOKEN_KEY);
    if (saved?.access_token && saved.expires_at - Date.now() > 60000) return { token: saved.access_token, door: "web" };

    const redirect = chrome.identity.getRedirectURL(); // https://<ext-id>.chromiumapp.org/
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: WEB_CLIENT_ID,
        response_type: "token",
        redirect_uri: redirect,
        scope: scopes(),
        include_granted_scopes: "true",
        prompt: interactive ? "select_account consent" : "none",
        ...(saved?.email ? { login_hint: saved.email } : {}),
      }).toString();
    const back = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url, interactive }, (u) => {
        if (chrome.runtime.lastError || !u) reject(new Error(chrome.runtime.lastError?.message || "auth cancelled"));
        else resolve(u);
      });
    });
    const frag = new URLSearchParams(new URL(back).hash.slice(1));
    const access_token = frag.get("access_token");
    if (!access_token) throw new Error(frag.get("error") || "no access token");
    const expires_at = Date.now() + (Number(frag.get("expires_in")) || 3500) * 1000;
    let email = saved?.email || "";
    try {
      const info = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${access_token}` } }).then((r) => r.json());
      email = info.email || email;
    } catch {}
    await chrome.storage.local.set({ [WEB_TOKEN_KEY]: { access_token, expires_at, email } });
    return { token: access_token, door: "web" };
  }

  async function getToken(interactive) {
    const state = await status();
    if (state.selectedDoor === "web" && WEB_CLIENT_ID) {
      return getWebToken(interactive);
    }
    try {
      const t = await getChromeToken(interactive);
      return t;
    } catch (e) {
      if (!WEB_CLIENT_ID) throw e;
      return getWebToken(interactive);
    }
  }

  async function forgetToken({ token, door }) {
    if (door === "web") await chrome.storage.local.remove(WEB_TOKEN_KEY);
    else await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
  }

  // Background callers (the worker's minute timer) must never open an account
  // chooser on their own: FA.google.setInteractive(false) makes a missing token an error instead.
  let allowInteractive = true;
  let pendingConnect = null;

  async function api(url, { method = "GET", body, token, retry = true } = {}) {
    token = token || (await getToken(false));
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) {
      // Token expired/revoked: drop it and try once more.
      await forgetToken(token);
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
    connect() {
      if (!pendingConnect) pendingConnect = getToken(allowInteractive).then(rememberConnection).then(() => true).finally(() => { pendingConnect = null; });
      return pendingConnect;
    },
    status,

    /** True if a cached token exists (no prompt). */
    setInteractive(v) {
      allowInteractive = Boolean(v);
    },

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
        await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token.token)}`).catch(() => {});
        await forgetToken(token);
      } catch {}
      await chrome.storage.local.remove(WEB_TOKEN_KEY);
      await chrome.storage.local.set({ [AUTH_STATE_KEY]: emptyState() });
    },

    /** Which account is connected, for the settings row. */
    async account() {
      const state = await status();
      if (state.status !== "connected") return null;
      const { [WEB_TOKEN_KEY]: saved } = await chrome.storage.local.get(WEB_TOKEN_KEY);
      return { door: state.selectedDoor, email: state.selectedDoor === "web" ? saved?.email || "" : "" };
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

    /**
     * Append a headed block of text to the end of a doc (Ben's build:
     * "write this step"). Only ever writes to a doc this app knows about.
     */
    async appendToDoc(docId, heading, text) {
      const doc = await api(`${DOCS}/documents/${docId}`);
      const content = doc.body?.content || [];
      const endIndex = (content[content.length - 1]?.endIndex || 2) - 1;
      const head = String(heading || "").trim();
      const body = String(text || "").trim();
      const chunk = `\n${head}\n${body}\n`;
      const requests = [{ insertText: { location: { index: endIndex }, text: chunk } }];
      if (head) {
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: endIndex + 1, endIndex: endIndex + 1 + head.length + 1 },
            paragraphStyle: { namedStyleType: "HEADING_2" },
            fields: "namedStyleType",
          },
        });
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: endIndex + 1 + head.length + 1, endIndex: endIndex + chunk.length },
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            fields: "namedStyleType",
          },
        });
      }
      await api(`${DOCS}/documents/${docId}:batchUpdate`, { method: "POST", body: { requests } });
      return { words: body.split(/\s+/).filter(Boolean).length };
    },

    /* ---------------------------------------------------------------- *
     * Docs: format + edit (lib/docops.js does the index math)
     * ---------------------------------------------------------------- */

    /** Raw documents.get JSON. */
    async getDoc(urlOrId) {
      return api(`${DOCS}/documents/${this.docIdFrom(urlOrId)}`);
    },

    /**
     * Formatting only (every build): restyle without changing words.
     * preset: "mla" (TNR 12, double, 1" margins) | "clean" (Arial 11, headings, bullets).
     */
    async formatDoc(urlOrId, preset = "mla") {
      const id = this.docIdFrom(urlOrId);
      const doc = await this.getDoc(id);
      const requests = FA.docOps.formatRequests(doc, preset);
      if (!requests.length) return { applied: 0 };
      await api(`${DOCS}/documents/${id}:batchUpdate`, { method: "POST", body: { requests } });
      return { applied: requests.length, paragraphs: FA.docOps.paragraphsOf(doc).length };
    },

    /**
     * Write anything anywhere (Ben's build): apply brain-authored ops.
     * See FA.docOps.editRequests for the op vocabulary.
     */
    async editDoc(urlOrId, ops) {
      const id = this.docIdFrom(urlOrId);
      const doc = await this.getDoc(id);
      const requests = FA.docOps.editRequests(doc, ops);
      if (!requests.length) return { applied: 0 };
      await api(`${DOCS}/documents/${id}:batchUpdate`, { method: "POST", body: { requests } });
      return { applied: requests.length };
    },

    /** Download a Drive file's bytes (PDF etc.) with the connected account. */
    async fetchDriveFileBytes(fileId) {
      const token = await getToken(false);
      const res = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${token.token}` } });
      if (!res.ok) throw new Error(`Drive ${res.status}${res.status === 404 ? " (not shared with the connected account?)" : ""}`);
      return res.arrayBuffer();
    },

    /** Recent Google Docs the connected account can open (needs the drive scope). */
    async listRecentDocs(n = 10) {
      const r = await api(`${DRIVE}/files?` + new URLSearchParams({
        q: "mimeType='application/vnd.google-apps.document' and trashed=false",
        orderBy: "modifiedTime desc",
        pageSize: String(n),
        fields: "files(id,name,modifiedTime,webViewLink)",
      }));
      return r.files || [];
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
