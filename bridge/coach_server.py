"""Focus Agent coach bridge.

One local server, two jobs:
  - serves the project statically (so the demo portal works as before)
  - POST /coach: runs the real Claude brain via `claude -p` (headless
    Claude Code, which uses the student's existing login -- NO API key needed)

Run from the project root:
    python3 bridge/coach_server.py        # http://localhost:8000

The extension's ClaudeCoach calls POST /coach; if this server isn't
running, the extension silently falls back to the built-in rule-based
MockCoach. Latency per call is roughly 5-20s (a fresh Claude session
spins up each time), and every call spends a little of the student's Claude
plan quota -- fine for personal use, replaced by a proper backend once
the API key exists.
"""

import json
import re
import subprocess
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

PORT = 8000
MODEL = "opus"         # coaching quality matters more than speed; sonnet was noticeably dumber
CLAUDE_TIMEOUT = 150   # seconds; headless cold starts take a few seconds alone

PROJECT_ROOT = Path(__file__).resolve().parent.parent

COACH_IDENTITY = (
    "You are Focus Agent, a study assistant inside a Chrome extension used by a "
    "high-school student. Voice: plain, calm, precise -- like a good tutor who "
    "respects the student's time. No emoji, no slang, no pep talk, no jokes, no "
    "motivational filler. Never call them 'buddy', 'legend', or similar. Don't "
    "comment on their mood. Answer the question that was asked, completely, then "
    "stop. Inside JSON string values never use double quotes -- use single quotes ' "
    "when you need to quote something. "
)

# Help policy. "answer": behave like a strong tutor who will also give the
# final answer when asked. "tutor": teach fully but stop short of the final
# answer to a graded question. Per-install setting; the extension sends it.
POLICY = {
    "answer": (
        "Help policy: the student has asked for full help. Explain the concept, "
        "walk through the method step by step, and give the final answer or the "
        "finished sentence when that is what they asked for. Show your working so "
        "they could reproduce it."
    ),
    "tutor": (
        "Help policy: teach fully -- explain the concept, walk through the method, "
        "check their reasoning, point at mistakes -- but do not hand over the final "
        "answer to a graded question or write their sentences for them. Lead them to "
        "it."
    ),
}


def _policy(p):
    return POLICY.get(str(p.get("mode") or "tutor"), POLICY["tutor"])

# Prompt builders per coach method. Each receives the request payload and
# returns (prompt_text, expected_top_level_keys) for validation.

def build_pick(p):
    return (
        f"{COACH_IDENTITY}\n\n"
        f"Assignments (ranked by urgency, with the student's personal time estimates):\n"
        f"{json.dumps(p.get('assignments', []))}\n\n"
        f"the student's recent stats: {json.dumps(p.get('stats', {}))}\n\n"
        'Choose the ONE assignment the student should start right now. Reply JSON: '
        '{"id": "<assignment id>", "reason": "<≤25 words, concrete and motivating, '
        'reference real numbers (time estimates, deadlines) when they help>"}'
    ), ["id", "reason"]


def build_panic(p):
    return (
        f"{COACH_IDENTITY}\n\n"
        f"EMERGENCY TRIAGE. the student has {p.get('minutesAvailable')} minutes tonight.\n"
        f"Assignments due soon: {json.dumps(p.get('assignments', []))}\n\n"
        "Build tonight's plan. Be honest about what dies -- an impossible plan is "
        "worse than a hard call. Order by value-per-minute; big point totals and "
        "overdue work first; it's fine to schedule a partial ('get the skeleton "
        "done'). Reply JSON: "
        '{"order": [{"id": "...", "minutes": <int>, "note": "<≤8 words>"}], '
        '"sacrifices": [{"id": "...", "why": "<≤15 words, honest>"}], '
        '"pep": "<≤20 words, factual summary of the plan>"}. '
        "Total scheduled minutes must fit the available time."
    ), ["order", "sacrifices", "pep"]


def build_breakdown(p):
    return (
        f"{COACH_IDENTITY}\n\n"
        f"Assignment: {json.dumps(p.get('assignment', {}))}\n\n"
        "Break it into concrete steps a 9th grader can start immediately. First "
        "step must take under 5 minutes (starting is the hard part). Steps must "
        "be specific to THIS assignment, not generic study advice. Reply JSON: "
        '{"steps": ["<step>", ...]} with 3-6 steps.'
    ), ["steps"]


def build_breakdown_steps(p):
    return (
        f"{COACH_IDENTITY}\n\n"
        f"Assignment (instructions included when the portal had them): {json.dumps(p.get('assignment', {}))}\n\n"
        "Break it into a checklist a 9th grader can start immediately. Each step "
        "names what EXISTS when it's done (the deliverable) and how many minutes it "
        "takes at a normal pace -- every step 3-25 minutes, the first under 5. Steps "
        "must be specific to THIS assignment (quote its parts), not generic study "
        "advice. Make the task SMALLER, not easier: don't do the work, cut it up. "
        'Reply JSON: {"steps": [{"text": "<instruction, ≤18 words>", '
        '"deliverable": "<what exists when done, ≤12 words>", "estMin": <int>}]} '
        "with 3-7 steps."
    ), ["steps"]


def build_split_step(p):
    return (
        f"{COACH_IDENTITY}\n\n"
        f"Assignment: {json.dumps(p.get('assignment', {}))}\n"
        f"The student says this step is still too big: {json.dumps(p.get('step', {}))}\n\n"
        "Split it into 2-3 smaller steps whose minutes add up to roughly the original. "
        "The first must be something they can do in under 5 minutes with zero thinking "
        "(open, copy, list, reread). Specific to this assignment. "
        'Reply JSON: {"steps": [{"text": "<≤18 words>", "deliverable": "<≤12 words>", "estMin": <int>}]}'
    ), ["steps"]


def build_autopsy(p):
    return (
        f"{COACH_IDENTITY}\n\n"
        f"the student's logged focus data (sessions, timing, distractions, commitments):\n"
        f"{json.dumps(p.get('data', {}))}\n\n"
        "Give him honest, non-judgy insights about his real work patterns -- the "
        "kind a good coach spots that he can't see himself. Numbers over vibes. "
        'Reply JSON: {"insights": ["<insight, ≤30 words>", ...]} with 3-5 insights.'
    ), ["insights"]


def build_chat(p):
    """Free-form chat. Returns PLAIN TEXT (not JSON) so the model can use
    normal prose, line breaks and simple markdown without JSON-escaping
    pain. The handler wraps it as {"reply": text}."""
    transcript = "\n".join(
        f"{'Student' if m.get('role') == 'user' else 'Assistant'}: {str(m.get('text', ''))[:1500]}"
        for m in (p.get("messages") or [])[-20:]
    )
    doc = p.get("doc") or None
    doc_block = ""
    if doc:
        doc_block = (
            f"The Google Doc open on the student's screen right now -- title: {doc.get('title','')!r}"
            f"{' (truncated)' if doc.get('truncated') else ''}:\n---\n{str(doc.get('text',''))[:30000]}\n---\n\n"
        )
    elif p.get("docNote"):
        doc_block = f"Note about the student's screen: {p['docNote']}\n\n"
    focus = p.get("focus") or None
    focus_block = ""
    if focus:
        focus_block = (
            "THE ASSIGNMENT THE STUDENT IS WORKING ON RIGHT NOW (the conversation is "
            f"about this unless they change the subject): {json.dumps(focus.get('assignment', {}))}\n"
            f"Their checklist for it (done flags are real): {json.dumps(focus.get('steps', []))}\n"
            f"Minutes into this work session: {focus.get('elapsedMin', 0)}\n\n"
        )
    return (
        f"{COACH_IDENTITY}\n\n"
        f"{_policy(p)}\n\n"
        "What you can see (be accurate if asked): the student's assignments, grades "
        "and schedule from their school portal; the assignment they're working on "
        "and its checklist; and, if a Google Doc is open in their active tab, its "
        "full text (below). Nothing else on their screen.\n\n"
        f"{focus_block}"
        f"{_context_block(p)}"
        f"{doc_block}"
        f"The student's current assignments: {json.dumps(p.get('assignments', []))}\n"
        f"The student's stats: {json.dumps(p.get('stats', {}))}\n\n"
        f"Conversation so far:\n{transcript}\n\n"
        "Reply to the student's last message. Use as many words as the answer needs "
        "and no more (a quick question gets a short answer; a 'walk me through this' "
        "gets the full walkthrough). Plain text with simple markdown allowed (**bold**, "
        "lists, line breaks). Do not wrap the reply in JSON or code fences."
    ), []


def _context_block(p):
    """Shared 'what the coach knows' block from the privacy-stripped snapshot."""
    ctx = p.get("context") or {}
    if not ctx:
        return ""
    return (
        f"What you know about the student's semester (from their school portal):\n"
        f"Classes + current grades: {json.dumps(ctx.get('classes', []))}\n"
        f"Schedule this week: {json.dumps(ctx.get('schedule', [])[:20])}\n"
        f"Risks: {json.dumps(ctx.get('risks', []))}\n\n"
    )


def build_explain(p):
    """Translate an assignment's instructions into a plain, digestible plan.

    This is 'dumb it down' done right: what the teacher actually wants, in
    the student's language, with the hidden expectations surfaced. It never
    produces the answer -- only understanding + a first move.
    """
    a = p.get("assignment", {})
    return (
        f"{COACH_IDENTITY}\n\n"
        f"{_context_block(p)}"
        f"Assignment (from the portal): {json.dumps(a)}\n\n"
        "Explain this assignment to the student clearly: "
        "what the teacher is really asking for, what 'done well' looks like, the "
        "traps students fall into, and the very first thing to do. Plain language, "
        "no jargon, no filler. Do NOT do the assignment or give answers. Reply JSON: "
        '{"tldr": "<≤25 words: what this actually is>", '
        '"wants": ["<what the teacher wants, ≤15 words each>", ...] (2-4 items), '
        '"traps": ["<common mistake, ≤15 words>", ...] (1-3 items), '
        '"firstMove": "<the under-5-minute first step>", '
        '"estMinutes": <int honest estimate>}'
    ), ["tldr", "wants", "firstMove"]


def build_precheck(p):
    """Grade-before-you-turn-it-in: tutor feedback on a draft, not a rewrite.

    Hard rule: the model points at problems and asks questions; it does not
    write replacement text. That's the line between coaching and cheating,
    and it is also what teachers will accept.
    """
    a = p.get("assignment", {})
    draft = str(p.get("draft", ""))[:12000]
    rubric = str(p.get("rubric", ""))[:2000]
    return (
        f"{COACH_IDENTITY}\n\n"
        f"Assignment: {json.dumps(a)}\n"
        + (f"Rubric / teacher expectations: {rubric}\n" if rubric else "")
        + f"\nThe student's DRAFT (not yet submitted):\n---\n{draft}\n---\n\n"
        "Act as a strict-but-kind tutor reviewing this before submission. Check it "
        "against what the assignment asks for. Find the biggest problems first. "
        "For each issue: quote the exact words from the draft (short), say what's "
        "wrong, and ask a question or give a hint that leads the student to fix it "
        "THEMSELVES. NEVER write replacement sentences or the answer. If it's "
        "genuinely good, say so and what makes it good. Reply JSON: "
        '{"grade": "<honest letter estimate, e.g. B+>", '
        '"strengths": ["<specific, ≤20 words>", ...] (1-3), '
        '"issues": [{"quote": "<≤12 words from the draft>", "problem": "<≤25 words>", '
        '"hint": "<question or nudge, ≤25 words, no rewritten text>"}, ...] (up to 5, biggest first), '
        '"missing": ["<requirement from the assignment not addressed>", ...], '
        '"nextStep": "<one concrete thing to do now>"}'
    ), ["grade", "issues", "nextStep"]


def build_setup(p):
    """Smart Setup: read the instructions, plan the prep, touch none of the work.

    The extension sends a NUMBERED inventory of safe resources (teacher links
    from the instructions, the class's Blackbaud topics/modules, whether
    Google Docs is connected). The model may only pick indices from that
    inventory -- it never invents a URL. Output is a setup plan; the student
    keeps every part that is actually the assignment.
    """
    a = p.get("assignment", {})
    res = p.get("resources", {})
    return (
        f"{COACH_IDENTITY}\n{_policy(p)}\n\n"
        f"{_context_block(p)}"
        f"Assignment (from the portal, instructions included): {json.dumps(a)}\n\n"
        f"Available resources -- you may ONLY reference these by their numbers:\n"
        f"Teacher links from the instructions: {json.dumps(res.get('links', []))}\n"
        f"This class's Blackbaud topics/modules: {json.dumps(res.get('topics', []))}\n"
        f"Google Docs connected: {bool(res.get('googleConnected'))}\n\n"
        "You are the student's hands for SETUP ONLY. Read the instructions and "
        "decide: which of the numbered resources should be opened right now "
        "(only ones the instructions actually call for or clearly need -- opening "
        "everything is noise); whether a fresh Google Doc would help (essays/"
        "written work, and only if connected); what physical or digital materials "
        "to gather (textbook chapter, calculator, notes -- only if the "
        "instructions imply them); then state in one line the part only the "
        "student can do, and an under-5-minute first move. Do NOT do, solve, or "
        "answer any of the actual work. Reply JSON: "
        '{"opens": [{"kind": "link"|"topic", "i": <number from the inventory>, '
        '"why": "<≤8 words>"}] (0-3 items), '
        '"doc": true|false, '
        '"gather": ["<item, ≤10 words>", ...] (0-4 items), '
        '"focus": "<the part only the student can do, ≤20 words>", '
        '"firstMove": "<under-5-min first step, ≤20 words>", '
        '"confidence": <0.0-1.0: how sure you are what this assignment actually wants; '
        'below 0.6 when instructions are missing or ambiguous>, '
        '"missing": ["<the ONE specific question you would ask the student to be sure, ≤20 words>"] '
        '(empty when confidence ≥ 0.6)}'
    ), ["opens", "focus", "firstMove"]


def build_debrief(p):
    return (
        f"{COACH_IDENTITY}\n\n"
        f"the student just finished a focus session: {json.dumps(p.get('session', {}))}\n"
        f"His week so far: {json.dumps(p.get('weekStats', {}))}\n\n"
        "Give him ONE closing line for this session -- specific to the numbers, "
        "honest, warm. Celebrate what's real, don't invent praise. Reply JSON: "
        '{"line": "<≤25 words>"}'
    ), ["line"]


BUILDERS = {
    "pick": build_pick,
    "panicPlan": build_panic,
    "breakdown": build_breakdown,
    "breakdownSteps": build_breakdown_steps,
    "splitStep": build_split_step,
    "autopsy": build_autopsy,
    "chat": build_chat,
    "explain": build_explain,
    "precheck": build_precheck,
    "setup": build_setup,
    "debrief": build_debrief,
}


def ask_claude_text(prompt: str) -> str:
    """Run one headless Claude call and return the raw text reply."""
    proc = subprocess.run(
        ["claude", "-p", "--model", MODEL, "--output-format", "json"],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=CLAUDE_TIMEOUT,
        cwd=str(Path.home()),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p failed: {proc.stderr[:200]}")
    text = json.loads(proc.stdout).get("result", "")
    return re.sub(r"^```(?:markdown|md)?\s*|\s*```$", "", text.strip())


def ask_claude(prompt: str):
    """Run one headless Claude call and parse the JSON out of its reply."""
    proc = subprocess.run(
        ["claude", "-p", "--model", MODEL, "--output-format", "json"],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=CLAUDE_TIMEOUT,
        cwd=str(Path.home()),  # neutral cwd: no project CLAUDE.md noise in the call
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p failed: {proc.stderr[:200]}")

    envelope = json.loads(proc.stdout)
    text = envelope.get("result", "")
    # Claude was told JSON-only, but strip fences defensively.
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("no JSON object in Claude reply")
    return _parse_json_lenient(match.group(0))


def _parse_json_lenient(text: str):
    """json.loads with a repair pass for the model's most common slip:
    unescaped double quotes inside a string value (e.g. quoting a draft)."""
    try:
        return json.loads(text, strict=False)
    except json.JSONDecodeError:
        pass
    # Repair: walk the text; inside a string, a '"' that is NOT followed by a
    # structural char (, : } ]) after optional whitespace is an inner quote.
    out, in_str, i, n = [], False, 0, len(text)
    while i < n:
        ch = text[i]
        if in_str:
            if ch == "\\":
                out.append(text[i:i + 2]); i += 2; continue
            if ch == '"':
                nxt = text[i + 1:i + 40].lstrip()
                if nxt[:1] in (",", ":", "}", "]", ""):
                    in_str = False
                    out.append(ch)
                else:
                    out.append("'")  # inner quote -> single quote
                i += 1; continue
            out.append(ch); i += 1; continue
        if ch == '"':
            in_str = True
        out.append(ch); i += 1
    return json.loads("".join(out), strict=False)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            return self._send_json(200, {"ok": True, "brain": "claude", "model": MODEL})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/coach":
            return self._send_json(404, {"error": "unknown endpoint"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length))
            method = req.get("method")
            builder = BUILDERS.get(method)
            if not builder:
                return self._send_json(400, {"error": f"unknown method: {method}"})

            prompt, required = builder(req.get("payload", {}))
            if method == "chat":
                return self._send_json(200, {"ok": True, "result": {"reply": ask_claude_text(prompt)}})
            result = ask_claude(prompt)
            missing = [k for k in required if k not in result]
            if missing:
                return self._send_json(502, {"error": f"reply missing keys: {missing}"})
            return self._send_json(200, {"ok": True, "result": result})
        except Exception as e:  # noqa: BLE001 -- report anything to the client
            return self._send_json(500, {"error": str(e)[:300]})

    def log_message(self, fmt, *args):
        # Quieter logs: only /coach traffic.
        if "/coach" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    print(f"Focus Agent bridge on http://127.0.0.1:{PORT}")
    print(f"  demo portal : http://localhost:{PORT}/demo-portal/")
    print(f"  coach brain : claude -p (headless, model={MODEL})")
    # ThreadingHTTPServer matters: brain calls take 15s+, and a single-threaded
    # server would queue the panel's 1.5s health checks behind them.
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
