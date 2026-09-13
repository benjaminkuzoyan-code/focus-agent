/**
 * scripts/test-panel-boundary.js - client-side regression for the student /
 * developer boundary (Codex review R1 of 7c65bbd).
 *
 * Runs the REAL source functions (sliced out of sidepanel/panel.js and
 * lib/ai.js) in a Node VM with fake Google/Chrome effects, and asserts:
 *   - only a current, positive "dev" answer from the server enables developer
 *     actions: missing / none / student / old-server-without-role / a stale
 *     answer from a previous server or code all block them
 *   - blocked = zero document writes and zero calendar writes even with
 *     devMode:true and autoDone:true saved, and a docops reply injected
 *   - a failed or out-of-order health refresh clears authorization
 *   - student Google Docs tools (format my doc; outline creation) are NOT
 *     gated on the developer role
 * No Chrome profile, OAuth token, provider or product file is touched.
 * Run: node scripts/test-panel-boundary.js   (exit 0 = all green)
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const root = path.resolve(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "sidepanel/panel.js"), "utf8");
const ai = fs.readFileSync(path.join(root, "lib/ai.js"), "utf8");

const results = [];
const check = (name, ok, detail = "") => { results.push([name, !!ok]); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  -- " + detail}`); };

/** Slice a top-level function by its opening line; it ends at the first "\n}\n". */
function fn(source, start) {
  const a = source.indexOf(start);
  if (a < 0) throw new Error("marker not found: " + start);
  const b = source.indexOf("\n}\n", a);
  return source.slice(a, b + 3);
}
const roleFns = fn(panel, "function devAllowed()") + "\n" + fn(panel, "function applyRoleUI()");
const applyOps = fn(panel, "async function applyDocOpsFromReply(");
const autoActions = fn(panel, "async function autoActionsOnDone(");
const formatDoc = fn(panel, "async function formatMyDoc()");
const initCoach = ai.slice(ai.indexOf("  /** Which server + code a health answer belongs to."), ai.indexOf("  FA.MockCoach = MockCoach;"));
const bridgeSigSrc = ai.slice(ai.indexOf("  FA.bridgeSig ="), ai.indexOf("\n", ai.indexOf("  FA.bridgeSig =")) + 1);
const reply = "```docops\n" + JSON.stringify({ ops: [{ type: "append", text: "SYNTHETIC_EDIT" }], summary: "synthetic edit" }) + "\n```";

const SERVER = "https://coach.example", CODE = "code-1";

function makeContext({ health, settings }) {
  const effects = [];
  const toggle = {}, modeRow = {};
  const ctx = vm.createContext({
    settings, current: { assignment: { id: "a1" } },
    FA: {
      bridgeHealth: health,
      google: {
        editDoc: async (id, ops) => { effects.push({ kind: "doc", id, ops }); return { applied: ops.length }; },
        formatDoc: async (id) => { effects.push({ kind: "format", id }); return { applied: true, paragraphs: 3 }; },
        addEvent: async (event) => { effects.push({ kind: "calendar", event }); },
        isConnected: async () => true,
      },
      store: { patchAssignmentMeta: async () => {} },
    },
    PORTAL_URL_PATTERNS: [], chrome: { tabs: { query: async () => [] } },
    $: (id) => (id === "dev-toggle" ? toggle : { closest: () => modeRow, remove: () => {} }),
    document: { body: { classList: { toggle: () => {} } } },
    docTarget: async () => ({ id: "doc-1", url: "https://docs.google.com/document/d/doc-1/edit" }),
    showWorkTyping: () => {}, pushCoach: async () => {}, DEFAULT_BRIDGE: "http://127.0.0.1:8000",
  });
  vm.runInContext(bridgeSigSrc + "\n" + roleFns + "\n" + applyOps + "\n" + autoActions + "\n" + formatDoc, ctx);
  return { ctx, effects, toggle, modeRow };
}

(async () => {
  console.log("== role → side effects (devMode:true + autoDone:true saved, docops reply injected) ==");
  const saved = { devMode: true, autoDone: true, bridgeUrl: SERVER, bridgeToken: CODE };
  const sigOK = `${SERVER}|${CODE}`;
  const cases = [
    ["missing health (bridge offline)", undefined, false],
    ["role none (wrong code)", { role: "none", sig: sigOK }, false],
    ["role student", { role: "student", sig: sigOK }, false],
    ["old server, no role field", { ok: true, sig: sigOK }, false],
    ["dev but from a previous server/code (stale sig)", { role: "dev", sig: "https://old.example|other" }, false],
    ["dev, current server + code", { role: "dev", sig: sigOK }, true],
  ];
  for (const [name, health, expectDev] of cases) {
    const { ctx, effects, toggle, modeRow } = makeContext({ health, settings: { ...saved } });
    ctx.applyRoleUI();
    await ctx.applyDocOpsFromReply(reply, { id: "synthetic-doc" }, true);
    await ctx.autoActionsOnDone({ id: "synthetic-assignment", raw: {} }, { title: "Next", course: "X", estMin: 25 });
    const docs = effects.filter((e) => e.kind === "doc").length, cal = effects.filter((e) => e.kind === "calendar").length;
    check(`${name}: devAllowed=${expectDev}`, ctx.devAllowed() === expectDev, String(ctx.devAllowed()));
    check(`${name}: doc writes=${expectDev ? 1 : 0}, calendar writes=${expectDev ? 1 : 0}`, docs === (expectDev ? 1 : 0) && cal === (expectDev ? 1 : 0), `docs=${docs} cal=${cal}`);
    check(`${name}: dev switch ${expectDev ? "enabled" : "disabled"}, mode row ${expectDev ? "shown" : "hidden"}`, toggle.disabled === !expectDev && modeRow.hidden === !expectDev, `disabled=${toggle.disabled} hidden=${modeRow.hidden}`);
  }
  {
    const { ctx } = makeContext({ health: { role: "dev", sig: sigOK }, settings: { ...saved, devMode: false } });
    check("dev role but switch off: devAllowed=false (the switch still matters for the developer)", ctx.devAllowed() === false);
  }

  console.log("== student Google Docs tools stay available ==");
  {
    const { ctx, effects } = makeContext({ health: { role: "student", sig: sigOK }, settings: { ...saved } });
    await ctx.formatMyDoc();
    check("student: format my doc still runs (1 format call, 0 doc-body writes)", effects.filter((e) => e.kind === "format").length === 1 && effects.filter((e) => e.kind === "doc").length === 0, JSON.stringify(effects));
  }
  {
    // The outline doc is created when the plan wants one and Google is connected — never on the developer role.
    const at = panel.indexOf("createOutlineDoc(");
    const before = panel.slice(Math.max(0, at - 600), at);
    check("outline creation is gated on plan.doc + Google, not on devAllowed (source check)", at > 0 && before.includes("if (plan.doc && resources.googleConnected)") && !before.includes("devAllowed("), "outline gate changed");
  }
  check("createOutlineDoc / formatDoc call sites never check devAllowed (source check)", !/devAllowed\([^)]*\)[^\n]*(createOutlineDoc|formatDoc)/.test(panel), "found a gate");

  console.log("== initCoach: refresh failures and stale answers clear authorization ==");
  function coachContext(fetchImpl, cfg = { local: false, url: SERVER, token: CODE }) {
    const ctx = vm.createContext({
      FA: { bridgeHealth: { role: "dev", sig: sigOK, who: "ben" } }, bridgeCfg: cfg, DEFAULT_BRIDGE: "http://127.0.0.1:8000",
      loadBridgeConfig: async () => {}, bridgeHeaders: () => ({}), AbortController, setTimeout: () => 1, clearTimeout: () => {},
      fetch: fetchImpl, MockCoach: class {}, ClaudeCoach: class {}, console: { warn: () => {} },
    });
    vm.runInContext(initCoach, ctx);
    return ctx;
  }
  {
    const ctx = coachContext(async () => { throw new Error("synthetic network failure"); });
    const brain = await ctx.FA.initCoach();
    check("failed health refresh → rules brain AND role cleared", brain === "rules" && !ctx.FA.bridgeHealth, JSON.stringify(ctx.FA.bridgeHealth));
  }
  {
    const ctx = coachContext(async () => ({ json: async () => ({ ok: true, auth: true, who: null }) }));
    await ctx.FA.initCoach();
    check("wrong code on a hosted bridge → badToken, role none", ctx.FA.bridgeHealth?.badToken === true && ctx.FA.bridgeHealth.role === "none", JSON.stringify(ctx.FA.bridgeHealth));
  }
  {
    const ctx = coachContext(async () => ({ json: async () => ({ ok: true, who: "ben" }) }));
    await ctx.FA.initCoach();
    check("old server without a role field → role none (never assumed dev)", ctx.FA.bridgeHealth?.role === "none", JSON.stringify(ctx.FA.bridgeHealth));
  }
  {
    const ctx = coachContext(async () => ({ json: async () => ({ ok: true, who: "amy", role: "student" }) }));
    await ctx.FA.initCoach();
    check("dev → student after a code change: role student, sig bound to the config", ctx.FA.bridgeHealth?.role === "student" && ctx.FA.bridgeHealth.sig === sigOK, JSON.stringify(ctx.FA.bridgeHealth));
  }
  {
    // Out of order: probe 1 (old, says dev) resolves AFTER probe 2 (new, says student).
    let resolveFirst;
    const first = new Promise((r) => { resolveFirst = r; });
    let n = 0;
    const ctx = coachContext(async () => (++n === 1 ? first : { json: async () => ({ ok: true, who: "amy", role: "student" }) }));
    const p1 = ctx.FA.initCoach();
    const p2 = ctx.FA.initCoach();
    await p2;
    resolveFirst({ json: async () => ({ ok: true, who: "ben", role: "dev" }) });
    await p1;
    check("out-of-order refresh: the late 'dev' answer is ignored, role stays student", ctx.FA.bridgeHealth?.role === "student", JSON.stringify(ctx.FA.bridgeHealth));
  }
  {
    const ctx = coachContext(async () => ({ json: async () => ({ ok: true, who: "ben", role: "dev" }) }));
    await ctx.FA.initCoach();
    check("current dev answer → role dev with the current sig", ctx.FA.bridgeHealth?.role === "dev" && ctx.FA.bridgeHealth.sig === sigOK, JSON.stringify(ctx.FA.bridgeHealth));
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
