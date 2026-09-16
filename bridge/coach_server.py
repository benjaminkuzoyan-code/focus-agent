"""Focus Agent coach bridge.

One local server, two jobs:
  - answers /health and /voice/local (no static file serving)
  - POST /coach: runs the real Claude brain. Two engines, picked at startup:
      * "api"        -- the Claude API (pip3 install anthropic). Used when an
                        API key is found in $ANTHROPIC_API_KEY or in
                        ~/.focus-agent/api_key (one line, the key). Fast
                        (a few seconds), and the coach's identity rides in a
                        real system prompt, so it stops behaving like a
                        coding agent that wandered into a homework app.
      * "claude-cli" -- headless `claude -p` with the student's Claude Code
                        login. No key needed, but 10-60s per call and it
                        drags Claude Code's own harness along. Fallback only.

Run from the project root:
    python3 bridge/coach_server.py        # http://localhost:8000
    python3 bridge/coach_server.py token alice   # mint an access code for a friend

Hosted (so friends can use it while Ben's laptop is closed): see deploy/README.md.
Set FA_HOST=0.0.0.0 and give every friend an access code (FA_TOKENS or
~/.focus-agent/tokens); the extension sends it as X-FA-Token. Each code has a
daily call cap (FA_DAILY_CAP, default 300) so one runaway install can't burn
the key.

The extension's ClaudeCoach calls POST /coach; if this server isn't
running, the extension silently falls back to the built-in rule-based
MockCoach. Restart the server after editing this file (the panel shows
"bridge needs restart").
"""

import base64
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

HOST = os.environ.get("FA_HOST", "127.0.0.1")           # 0.0.0.0 when hosted
PORT = int(os.environ.get("PORT", os.environ.get("FA_PORT", "8000")))
# Hosted = serving other people's browsers. FA_HOSTED=1 forces hosted rules
# while still binding loopback (the security tests use it).
HOSTED = HOST != "127.0.0.1" or os.environ.get("FA_HOSTED") == "1"
DAILY_CAP = int(os.environ.get("FA_DAILY_CAP", "300"))  # coach calls per access code per UTC day
MAX_BODY = int(os.environ.get("FA_MAX_BODY", str(6 * 1024 * 1024)))  # bytes; a 1600px JPEG screenshot is ~300 KB
# Extra browser origins allowed to call the bridge, for the developer's own
# tools only (the panel harness served from http://localhost:8766). Never set
# this on a hosted bridge.
ALLOW_ORIGINS = {o.strip() for o in os.environ.get("FA_ALLOW_ORIGINS", "").split(",") if o.strip()}
# Methods only the developer role may call: they produce finished work.
DEV_ONLY_METHODS = {"writeStep", "answerAll", "editDoc"}
TOKENS_FILE = Path.home() / ".focus-agent" / "tokens"
MODEL = "opus"         # claude-cli engine: coaching quality matters more than speed
CLAUDE_TIMEOUT = 150   # seconds; headless cold starts take a few seconds alone

# API engine. The key never ships in the extension; it lives here, on the
# machine running the bridge. Effort "medium" keeps chat replies in the
# few-second range; set FA_EFFORT=high for slower, deeper answers.
API_MODEL = os.environ.get("FA_API_MODEL", "claude-opus-5")
API_EFFORT = os.environ.get("FA_EFFORT", "medium")
API_KEY_FILE = Path.home() / ".focus-agent" / "api_key"
# claude-cli engine runs from an EMPTY directory on purpose: run from $HOME it
# picked up ~/CLAUDE.md and the auto-memory for that folder, so every coach
# call carried Ben's personal coding preferences and notes about other projects.
CLI_CWD = Path.home() / ".focus-agent" / "cwd"

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _api_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    try:
        return API_KEY_FILE.read_text().strip()
    except OSError:
        return ""


# FA_ENGINE=mock: no model at all -- replies describe what WOULD have been
# sent (role, policy, prompt facts) and count calls, so the security tests can
# prove a rejected request never reaches a model. Never used for real serving.
ENGINE = "mock" if os.environ.get("FA_ENGINE") == "mock" else ("api" if _api_key() else "claude-cli")
MOCK_COUNT_FILE = Path(os.environ.get("FA_MOCK_COUNT_FILE", "")) if os.environ.get("FA_MOCK_COUNT_FILE") else None


class CoachError(Exception):
    """An error the client may see. `public` is a fixed, content-free
    sentence; anything the provider or a traceback said stays in `detail`,
    which is never sent and never logged (only its class is)."""

    def __init__(self, public: str, detail: str = ""):
        super().__init__(public)
        self.public = public
        self.detail = detail


PUBLIC_DECLINED = "the coach declined that request"
PUBLIC_BRAIN_DOWN = "the coach's brain isn't available right now -- try again in a minute"
PUBLIC_BAD_REPLY = "the coach sent an unreadable reply -- try again"
PUBLIC_GENERIC = "the coach hit an error -- try again"


def _pseud(name) -> str:
    """Log identifier for a caller: a short hash of the code's name, so logs
    never carry a friend's name. Stable across restarts for the same name."""
    if not name:
        return "anon"
    return hashlib.sha256(str(name).encode()).hexdigest()[:8]


def _load_tokens():
    """({access code: name}, {names with the developer role}).

    Codes come from FA_TOKENS="alice:code1,bob:code2" and/or
    ~/.focus-agent/tokens (one `name code` per line, or `name code dev`).
    The developer role -- the only role that can turn on developer mode,
    answer mode, or the writing methods -- is granted by that `dev` word or
    by FA_DEV_TOKENS="ben,otherdev" (names). Empty codes + loopback = open,
    and an open loopback bridge is the developer's own machine.
    """
    out, devs = {}, set()
    for pair in os.environ.get("FA_TOKENS", "").split(","):
        if ":" in pair:
            name, tok = pair.split(":", 1)
            if tok.strip():
                out[tok.strip()] = name.strip()
    try:
        for line in TOKENS_FILE.read_text().splitlines():
            parts = line.split()
            if len(parts) >= 2 and not line.lstrip().startswith("#"):
                out[parts[1]] = parts[0]
                if len(parts) >= 3 and parts[2].lower() == "dev":
                    devs.add(parts[0])
    except OSError:
        pass
    for name in os.environ.get("FA_DEV_TOKENS", "").split(","):
        if name.strip():
            devs.add(name.strip())
    return out, devs


TOKENS, DEV_NAMES = _load_tokens()


IMAGE_REQUIRED_METHODS = ("readPhoto", "readScreen", "readPage")
MAX_IMAGES = 9   # one page/photo/screenshot, or up to 8 video frames (+ nothing else)


def _role(who, open_local: bool = False) -> str:
    """'dev' for the developer, 'student' for everyone else, 'none' for nobody.

    Developer = the verified OPEN loopback bridge (no codes configured, not
    hosted, peer is loopback -- i.e. the developer's own machine; this is a
    property of the connection, never of a name) or a code marked dev. A
    hosted code that happens to be NAMED "local" is just a student.
    FA_LOCAL_ROLE=student lets the developer try the student experience."""
    if who is None:
        return "none"
    if open_local:
        return "student" if os.environ.get("FA_LOCAL_ROLE") == "student" else "dev"
    return "dev" if who in DEV_NAMES else "student"


def _normalize_for_role(payload: dict, role: str) -> dict:
    """The server decides what the client is allowed to ask for. A student
    payload can say devMode:true or mode:'answer' all it likes; here it
    becomes tutor mode before any prompt is built. This is the boundary."""
    payload["_role"] = role
    if role != "dev":
        payload["devMode"] = False
        payload["mode"] = "tutor"
        payload.pop("voice", None)          # only hand-in text uses the voice profile; students get none written
    return payload
_usage = {}          # (name, utc day) -> calls today
_usage_lock = threading.Lock()


def _count_call(name: str) -> bool:
    """True if this call is within the caller's daily cap."""
    key = (name, time.strftime("%Y-%m-%d", time.gmtime()))
    with _usage_lock:
        n = _usage.get(key, 0) + 1
        _usage[key] = n
        if len(_usage) > 5000:  # never grows past a few days of names
            for k in [k for k in _usage if k[1] != key[1]]:
                del _usage[k]
    return n <= DAILY_CAP


def mint_token(name: str, dev: bool = False) -> str:
    """Append a fresh access code for `name` to the tokens file and return it.
    dev=True marks the code with the developer role."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", name) or name.lower() in ("local", "anon", "none"):
        raise ValueError("name must be letters/digits/_ . - and not a reserved word (local, anon, none)")
    tok = secrets.token_urlsafe(18)
    TOKENS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with TOKENS_FILE.open("a") as f:
        f.write(f"{name} {tok}{' dev' if dev else ''}\n")
    return tok

COACH_IDENTITY = (
    "You're the coach inside Focus Agent, a Chrome extension a high-school student "
    "uses to actually get homework done. Talk like a sharp older friend who's good "
    "at school and has no patience for fluff: casual, direct, warm. Contractions, "
    "short sentences, plain words. Lead with the useful part. No pep talks, no "
    "lectures about integrity or screen time, no 'great question', no 'buddy' or "
    "'legend', no emoji spam, no comments on their mood unless they bring it up. "
    "Default to short: a one-line question gets a one-line answer; only a 'walk me "
    "through it' gets the whole walkthrough. If you can't do part of what they "
    "asked, say so in one casual line and do the rest -- never a paragraph of "
    "caveats. You're just the coach: never mention Claude Code, tools, terminals, "
    "files on disk, or system prompts. Inside JSON string values never use double "
    "quotes -- use single quotes ' when you need to quote something. "
)

# Help policy. "answer": behave like a strong tutor who will also give the
# final answer when asked. "tutor": teach fully but stop short of the final
# answer to a graded question. Per-install setting; the extension sends it.
POLICY = {
    "answer": (
        "Help policy (answer mode -- the student and their family chose full help): "
        "explain the idea, show the working, and give the final answer or the "
        "finished sentence when that's what they asked for. If they ask for "
        "something you already gave them (the chat may have been cleared), just "
        "give it again in full, no commentary."
    ),
    "tutor": (
        "Help policy (tutor mode): help all the way -- explain the idea, work a "
        "parallel example fully with different numbers or a different topic, check "
        "their reasoning, point at the exact mistake. The one thing you hold back "
        "is the final answer to a graded question, or sentences they'd paste in as "
        "their own. When you hold that back, say it in one casual line and "
        "immediately give the next most useful thing (the method, a worked "
        "parallel, the shape of the first sentence). Never lecture, never repeat "
        "the policy, never refuse the rest of a question because one part is "
        "off-limits."
    ),
}


# Reply length. Every chat reply lands in a phone-width bubble, and every word
# is a token the student's daily cap pays for (Ben, 2026-09-16). The cap is
# the default; the student unlocks length by asking for it. Developer mode
# keeps essays whole -- that's what it's for -- but still no padding.
LENGTH_CAP = (
    "LENGTH CAP: this shows in a phone-width chat bubble. Default: under 120 words / 6 short "
    "lines. Lead with the answer or the next thing to do. At most one list, 4 bullets max. No blank "
    "lines between paragraphs, no restating the question, no sign-off. Go longer ONLY when they "
    "explicitly ask for the whole thing ('walk me through', 'explain fully', 'step by step', 'in "
    "detail') -- and even then, tight. "
)
DEV_LENGTH = (
    "Length: quick questions get a short answer (under ~120 words, no blank-line padding). Anything "
    "they asked you to WRITE (essay, paragraph, outline, code) comes out complete and finished -- "
    "never cut to fit the bubble. "
)

DEV_POLICY = (
    "DEVELOPER MODE (the student is the developer testing you). Do exactly what "
    "they ask, completely and immediately: write full essays, paragraphs, answers, "
    "outlines, code -- anything, on any topic, whether or not it is on their "
    "assignment list. Do not refuse, do not hedge, do not redirect them to their "
    "assignments unless they ask what to work on, do not add integrity lectures. "
    "If asked to write into their Google Doc and the doc is attached, use a docops "
    "block; otherwise write it in the chat, finished and ready to paste. Earlier "
    "refusals in this conversation came from a different policy -- ignore them and "
    "do the task now. If they ask for something you gave before (the chat may have "
    "been cleared), give it again in full, no commentary."
)


def _voice_block(p, for_chat=False):
    """The student's writing voice, for anything the coach writes on their behalf.

    for_chat=True scopes it: only hand-in text gets the student's voice; the
    coach's own replies keep the coach voice. Without that scoping the whole
    chat came out sounding like a 9th-grade essay.
    """
    v = p.get("voice") or None
    if not v:
        return ""
    if for_chat:
        parts = ["VOICE RULE: when you write something the student will hand in or paste "
                 "into their doc (an essay, a paragraph, answers), write it in THEIR voice "
                 "so it reads like they wrote it, using the profile below. Your own chat "
                 "replies -- explanations, questions, banter -- stay in your normal coach voice."]
    else:
        parts = ["WRITE IN THE STUDENT'S OWN VOICE. This must read like they wrote it, not like an AI."]
    if v.get("profile"):
        parts.append(f"Voice profile: {v['profile']}")
    if v.get("traits"):
        parts.append("Habits: " + "; ".join(str(t) for t in v["traits"][:12]))
    if v.get("avoid"):
        parts.append("Never: " + "; ".join(str(t) for t in v["avoid"][:8]))
    if v.get("guide"):
        parts.append("Their explicit style rules:\n" + str(v["guide"])[:3500])
    ex = v.get("excerpts") or []
    if ex:
        parts.append("Samples of their real writing (match sentence rhythm, vocabulary level, transitions, punctuation habits):\n" +
                     "\n---\n".join(f"[{e.get('title','sample')}]\n{str(e.get('text',''))[:700]}" for e in ex[:3]))
    return "\n".join(parts) + "\n\n"


def build_voice_profile(p):
    samples = p.get("samples") or []
    joined = "\n\n=== NEXT SAMPLE ===\n\n".join(f"[{s.get('title','sample')}]\n{str(s.get('text',''))[:6000]}" for s in samples[:8])
    return (
        "Here are pieces the student actually wrote. Describe HOW they write so another writer could "
        "imitate them precisely -- sentence length and rhythm, vocabulary level, how they open and close "
        "paragraphs, transitions they lean on, punctuation habits (semicolons, dashes, Oxford comma), "
        "first vs third person, how they use evidence, recurring quirks and favorite phrases, and what "
        "they never do. Be specific and quotable, not flattering.\n\n"
        + (f"Their explicit style rules (treat as authoritative):\n{str(p.get('guide',''))[:3000]}\n\n" if p.get("guide") else "")
        + f"Samples:\n{joined}\n\n"
        'Reply JSON: {"profile": "<one dense paragraph, ≤120 words, how they write>", '
        '"traits": ["<specific habit, ≤12 words>", ...] (6-12), '
        '"avoid": ["<thing that would give away an imitation, ≤10 words>", ...] (4-8)}'
    ), ["profile", "traits"]


def _policy(p):
    if p.get("devMode"):
        return DEV_POLICY
    return POLICY.get(str(p.get("mode") or "tutor"), POLICY["tutor"])


def _system(p):
    """The system prompt for every call: who the coach is + how much it helps.
    Lives in the real system slot (API) / --system-prompt (claude -p), which
    is what makes the help policy stick -- as plain text in the user turn it
    lost to the harness's own instructions and the coach refused things the
    policy explicitly allowed."""
    return f"{COACH_IDENTITY}\n\n{_policy(p)}"

# Prompt builders per coach method. Each receives the request payload and
# returns (prompt_text, expected_top_level_keys) for validation.

def build_pick(p):
    return (
        f"Assignments (ranked by urgency, with the student's personal time estimates):\n"
        f"{json.dumps(p.get('assignments', []))}\n\n"
        f"the student's recent stats: {json.dumps(p.get('stats', {}))}\n\n"
        "Rule: anything marked missing (a zero in the gradebook right now) or overdue comes before everything else -- "
        "pick the missing one with the biggest grade impact first; only when nothing is missing or overdue weigh the rest.\n"
        'Choose the ONE assignment the student should start right now. Reply JSON: '
        '{"id": "<assignment id>", "reason": "<≤25 words, concrete and motivating, '
        'reference real numbers (time estimates, deadlines) when they help>"}'
    ), ["id", "reason"]


def build_panic(p):
    return (
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
        f"Assignment: {json.dumps(p.get('assignment', {}))}\n\n"
        "Break it into concrete steps a 9th grader can start immediately. First "
        "step must take under 5 minutes (starting is the hard part). Steps must "
        "be specific to THIS assignment, not generic study advice. Reply JSON: "
        '{"steps": ["<step>", ...]} with 3-6 steps.'
    ), ["steps"]


def build_breakdown_steps(p):
    return (
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
        f"Assignment: {json.dumps(p.get('assignment', {}))}\n"
        f"The student says this step is still too big: {json.dumps(p.get('step', {}))}\n\n"
        "Split it into 2-3 smaller steps whose minutes add up to roughly the original. "
        "The first must be something they can do in under 5 minutes with zero thinking "
        "(open, copy, list, reread). Specific to this assignment. "
        'Reply JSON: {"steps": [{"text": "<≤18 words>", "deliverable": "<≤12 words>", "estMin": <int>}]}'
    ), ["steps"]


def build_summarize(p):
    return (
        f"The student highlighted this passage from {p.get('title') or 'a reading'!r}:\n---\n"
        f"{str(p.get('text', ''))[:12000]}\n---\n\n"
        "Summarize ONLY this passage for a 9th grader: 2-5 short bullet points, "
        "each a complete plain-English sentence, no filler, no intro line. Keep "
        "names, dates and numbers exact. Reply JSON: {\"summary\": \"<bullets "
        "separated by newlines, each starting with '• '>\"}"
    ), ["summary"]


def build_annotate_question(p):
    return (
        f"The student is annotating {p.get('title') or 'a reading'!r} and highlighted:\n---\n"
        f"{str(p.get('quote', ''))[:1500]}\n---\n\n"
        "Write the ONE question a sharp teacher would pencil in the margin next to "
        "this exact passage -- the question whose answer IS a good annotation. "
        "Specific to these words (name the thing in the passage), never generic, "
        "never answered. Under 18 words. Reply JSON: {\"question\": \"<question>\"}"
    ), ["question"]


def build_ask_passage(p):
    return (
        f"From {p.get('title') or 'a reading'!r}, the student highlighted:\n---\n"
        f"{str(p.get('quote', ''))[:4000]}\n---\n"
        f"Their question about it: {str(p.get('question', ''))[:500]}\n\n"
        "Answer about THIS passage. " + LENGTH_CAP +
        "Plain text, simple markdown allowed. Reply JSON: {\"reply\": \"<answer>\"}"
    ), ["reply"]


# ---- Ben's build (developer mode): the coach does the work ----------------

def build_write_step(p):
    doc = str(p.get("docText") or "")[:12000]
    return (
        "DEVELOPER MODE: the student has asked you to WRITE this part for them, "
        "finished and ready to paste. Do it fully -- no outlines, no 'you could', "
        "no placeholders. Match the assignment's requirements exactly; sound like "
        "a strong 9th grader, not a press release.\n\n"
        + _voice_block(p) +
        
        f"Assignment: {json.dumps(p.get('assignment', {}))}\n"
        f"The step to write: {json.dumps(p.get('step', {}))}\n"
        f"Checklist so far: {json.dumps(p.get('steps', []))}\n"
        + (f"What's already in their doc:\n---\n{doc}\n---\n" if doc else "")
        + '\nReply JSON: {"text": "<the finished text for this step, paragraphs separated by \\n\\n>"}'
    ), ["text"]


def build_answer_all(p):
    return (
        "DEVELOPER MODE: answer every question in this assignment fully. Show work "
        "where the subject calls for it (math, science). Number the answers to "
        "match the questions. Plain text.\n\n"
        + _voice_block(p) +
        
        f"Assignment (instructions included): {json.dumps(p.get('assignment', {}))}\n"
        + (f"Extra material the student pasted:\n---\n{str(p.get('extra') or '')[:8000]}\n---\n" if p.get("extra") else "")
        + '\nReply JSON: {"text": "<all answers>"}'
    ), ["text"]


def build_read_photo(p):
    # The image rides along with the call (see _complete); nothing else to fetch.
    return (
        "The image with this message is a photo of the student's handwritten or "
        "paper work for this assignment.\n\n"
        f"Assignment: {json.dumps(p.get('assignment', {}))}\n"
        f"Their checklist (index, text, deliverable): {json.dumps(p.get('steps', []))}\n\n"
        "Decide which checklist steps the photo shows as DONE (the deliverable "
        "visibly exists), give one honest line of feedback on the work itself "
        "(what's right, what to fix), and say if the photo was too blurry/dark to "
        "judge. Reply JSON: {\"legible\": true|false, \"stepsDone\": [<indexes>], "
        "\"feedback\": \"<≤40 words>\"}"
    ), ["legible", "stepsDone", "feedback"]


ANNOTATION_WORDS = re.compile(
    r"\b(annotat\w*|mark[- ]?up|marginalia|reading (notes|log|journal|response)|dialectical journal|"
    r"double[- ]entry|close[- ]read\w*|highlight\w*|active reading|take notes|notes on (the )?(reading|chapter|text|article|video))\b",
    re.I,
)


def _annotation_graded(assignment) -> bool:
    """The annotation rule (spec section 10): are the annotations / notes / a
    summary of this reading THE graded deliverable? Decided from the
    assignment's own words. No title and no instructions = we don't know ->
    treat it as graded (the conservative side: orientation only)."""
    a = assignment if isinstance(assignment, dict) else {}
    text = " ".join(str(a.get(k) or "") for k in ("title", "description", "type"))
    if not text.strip():
        return True
    return bool(ANNOTATION_WORDS.search(text))


def build_read_screen(p):
    """An image of what the student is looking at: a screenshot (source
    "screen": Google Doc, Drive preview, textbook page -- anything the text
    highlighter can't reach) or a photo they uploaded (source "photo": a book
    page, a worksheet, their own handwritten notes). Modes: a question ->
    answer it about what's visible; otherwise the annotation rule decides:
    annotating/summarizing IS the graded work -> orientation only (what it is,
    what to look for, questions), and the coach says why; it isn't -> a real
    reading companion: summary, key ideas, quotes worth marking, as many
    questions as the page deserves. Developers always get the full version.
    Every mode also transcribes the visible text so the rest of the coach
    (summaries, quizzes, practice tests) can use the page afterwards."""
    page = p.get("page") or {}
    question = str(p.get("question") or "").strip()
    source = "photo" if p.get("source") == "photo" else "screen"
    if source == "photo":
        what_it_is = (
            "The image with this message is a PHOTO the student took of what they're working on: a textbook or "
            "book page, a worksheet, a handout, or their own handwritten notes"
            f" (file: {json.dumps(page.get('title', ''))})."
        )
    else:
        what_it_is = (
            "The image with this message is a screenshot of what the student has on screen right now"
            f" (page title: {json.dumps(page.get('title', ''))}, site: {json.dumps(page.get('host', ''))})."
        )
    head = (
        what_it_is + "\n"
        f"Assignment they're working on: {json.dumps(p.get('assignment', {}))}\n\n"
        "Transcribe the main visible text faithfully (skip menus, sidebars, chrome; <= 1500 chars; "
        "handwriting too, as best you can; if it's a diagram or image, describe it in one or two sentences instead).\n"
    )
    if question:
        return head + (
            f"The student asks about this {source}: {json.dumps(question)}\n"
            "Answer it the way the help policy says (tutor mode: explain and guide, don't do graded work for them). "
            'Reply JSON: {"answer": "<<= 120 words>", "text": "<transcription>"}'
        ), ["answer"]
    graded = _annotation_graded(p.get("assignment"))
    if p.get("_role") != "dev" and graded:
        # Students get ORIENTATION, never the annotation itself: when the
        # assignment IS the annotation, "key ideas", a summary and "quotes
        # worth highlighting" would be the assessed work. The coach reacts to
        # their reading; it doesn't do it for them. It says so in one line.
        return head + (
            "This assignment's graded work IS the annotating / note-taking / summarizing of this reading, so do NOT do it for them. "
            "Orient the student before they read closely, WITHOUT doing the reading for them: "
            "what this is (one line), one plain line saying why you're not summarizing it (their annotations are the graded work), "
            "what to look for as they read (2-4 short pointers: the kind of "
            "thing a teacher wants noticed here -- claims, evidence, turns, vocabulary -- not the content itself), "
            "and the questions they should be able to answer after reading (questions only, no answers; as many as the page deserves, up to 8). "
            "Do NOT list key ideas, do NOT pick quotes, do NOT summarize the argument. "
            'Reply JSON: {"what": "<one line>", "why": "<one line>", "lookFor": ["..."], "questions": ["..."], "text": "<transcription>"}'
        ), ["what"]
    return head + (
        "Be the reading companion a good tutor is when the annotations are NOT what's graded: "
        "what this is (one line), a summary in 2-4 plain sentences (9th-grade words, the argument or the point, not a list), "
        "the 3-6 key ideas, "
        "as many questions as the page deserves that the student should be able to answer after reading it (questions only, no answers; up to 10), "
        "and up to 5 short exact quotes from the page worth marking, each with 3-8 words on why. "
        "If the page is the student's own handwritten work, the summary says what their notes cover and the key ideas point at what's missing or unclear. "
        'Reply JSON: {"what": "<one line>", "summary": "<2-4 sentences>", "keyIdeas": ["..."], "questions": ["..."], "quotes": ["<quote> — <why>"], "text": "<transcription>"}'
    ), ["what", "keyIdeas"]


def build_read_page(p):
    """One page of a PDF that has no usable text layer (a scan, a figure-only
    page, a worksheet, handwriting). The job is the eyes, not the analysis:
    transcribe what is there and describe each figure/diagram/graph/equation
    plainly, so the rest of the coach can work from it. Same for students and
    developers -- this is what OCR would do, never the assessed work."""
    page = p.get("page") or {}
    return (
        "The image with this message is ONE PAGE of a PDF the student attached to this assignment"
        f" (file: {json.dumps(page.get('title', ''))}, page {page.get('n', '?')} of {page.get('of', '?')}). "
        "Its text layer is empty, so you are its eyes.\n"
        f"Assignment: {json.dumps(p.get('assignment', {}))}\n\n"
        "1) Transcribe ALL the readable text on the page faithfully, in reading order, handwriting included "
        "(mark unreadable bits [?]); keep numbering, headings and blanks (write ____ for a blank to fill). <= 2500 chars.\n"
        "2) For every figure, diagram, graph, table, map, photo or equation, give a plain one-or-two-sentence description "
        "of what it shows (axes, labels, what's being compared, what the equation relates) -- describe, don't interpret or solve.\n"
        "If the page is blank or purely decorative say so. "
        'Reply JSON: {"text": "<transcription>", "figures": ["<description>", ...], "blank": true|false}'
    ), ["text"]


def _clock(t):
    try:
        t = int(float(t))
    except (TypeError, ValueError):
        return "?"
    return f"{t // 3600}:{(t % 3600) // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def build_video_summary(p):
    """A video (YouTube captions read from the student's open tab, optionally
    with frames screenshotted along the way). The annotation rule decides:
    notes on the video ARE the graded work -> orientation only (what it's
    about, why, what to listen for, moments worth pausing at, questions);
    otherwise a summary with timestamped key moments, terms, questions. A
    question typed first is answered from the captions."""
    video = p.get("video") or {}
    caps = p.get("captions") or []
    if not isinstance(caps, list):
        caps = []
    lines = []
    for c in caps[:600]:
        if isinstance(c, dict) and c.get("text"):
            lines.append(f"[{_clock(c.get('t', 0))}] {str(c['text'])[:400]}")
    transcript = "\n".join(lines)[:16000]
    n_frames = int(p.get("frames") or 0)
    head = (
        f"Video: {json.dumps(str(video.get('title') or '')[:150])}, length {_clock(video.get('duration', 0))}"
        f"{', auto-generated captions (names and numbers may be wrong)' if video.get('auto') else ''}.\n"
        f"Assignment they're working on: {json.dumps(p.get('assignment', {}))}\n"
        + (f"The {n_frames} images with this message are frames from the video, evenly spaced from start to end, in order -- "
           "use them for what is SHOWN (whiteboard, slides, diagrams, demos) that the captions don't say.\n" if n_frames else
           "You only have the captions: what was SAID. Anything only shown on screen is invisible to you -- say so if the assignment seems to need it.\n")
        + f"Captions with timestamps:\n---\n{transcript or '(no captions were readable)'}\n---\n\n"
    )
    question = str(p.get("question") or "").strip()
    if question:
        return head + (
            f"The student asks about this video: {json.dumps(question)}\n"
            "Answer it from the captions (and frames, if any) the way the help policy says (tutor mode: explain and guide, don't do graded work for them); "
            "cite the timestamp(s) you used. "
            'Reply JSON: {"answer": "<<= 150 words>", "moments": [{"t": <seconds>, "point": "<why this moment>"}]}'
        ), ["answer"]
    if p.get("_role") != "dev" and _annotation_graded(p.get("assignment")):
        return head + (
            "This assignment's graded work IS taking notes on / summarizing this video, so do NOT do it for them. "
            "Give: what the video is about in one line, one plain line saying why you're not summarizing it (their notes are the graded work), "
            "what to listen for (2-4 pointers: the kind of thing a teacher wants noticed -- claims, steps, turns, vocabulary -- not the content), "
            "moments worth pausing at (timestamp + a 3-6 word cue of the KIND of thing happening, never the content itself; up to 8), "
            "and the questions they should be able to answer afterwards (questions only, no answers; up to 8). "
            'Reply JSON: {"what": "<one line>", "why": "<one line>", "listenFor": ["..."], "moments": [{"t": <seconds>, "point": "<cue>"}], "questions": ["..."]}'
        ), ["what"]
    return head + (
        "Be the study companion a good tutor is when the notes are NOT what's graded: "
        "what the video is about in one line; a summary in 3-6 plain sentences (9th-grade words, the argument or the steps, not a list); "
        "the key moments with timestamps (up to 10: the seconds where each idea starts, and the idea in one sentence); "
        "terms worth knowing with a short meaning (up to 6); "
        "and questions the student should be able to answer after watching (questions only, no answers; up to 8). "
        "If something important is clearly shown but not said (the captions mention 'this diagram', 'as you can see'), say what you can't see. "
        'Reply JSON: {"what": "<one line>", "summary": "<3-6 sentences>", "keyPoints": [{"t": <seconds>, "point": "..."}], "terms": [{"term": "...", "meaning": "..."}], "questions": ["..."], "blind": ["<what was shown but not said, if anything>"]}'
    ), ["what", "summary"]


def build_edit_doc(p):
    return (
        "DEVELOPER MODE: you have full write access to the student's Google Doc. "
        "Carry out their instruction exactly, editing the document in place.\n\n"
        + _voice_block(p) +
        
        f"Assignment: {json.dumps(p.get('assignment', {}))}\n"
        f"The doc, as numbered paragraphs (i = paragraph index you address ops to):\n"
        f"{json.dumps(p.get('outline', []))}\n\n"
        f"Instruction: {str(p.get('instruction', ''))[:800]}\n\n"
        "Reply with a list of edit ops, applied together. Allowed ops:\n"
        '  {"type":"replaceAll","find":"<exact text>","replace":"<text>"}\n'
        '  {"type":"setStyle","paragraph":<i>,"style":"TITLE|HEADING_1|HEADING_2|HEADING_3|NORMAL_TEXT"}\n'
        '  {"type":"insertAfter","paragraph":<i>,"text":"<one or more paragraphs>"}\n'
        '  {"type":"replaceParagraph","paragraph":<i>,"text":"<new words for that paragraph>"}\n'
        '  {"type":"deleteParagraph","paragraph":<i>}\n'
        '  {"type":"append","text":"<text>"}\n'
        '  {"type":"replaceBody","text":"<the whole new document>"}  (only when asked to rewrite everything)\n'
        "Write finished prose where prose is asked for -- no placeholders, no notes to self. "
        'Reply JSON: {"ops": [...], "summary": "<≤20 words: what you changed>"}'
    ), ["ops"]


def build_flashcards(p):
    files = p.get("files") or []
    blocks = "\n\n".join(
        f"### {f.get('title','file')}\n{str(f.get('text',''))[:8000]}"
        + ("\nStudent highlights: " + json.dumps(f.get("highlights")) if f.get("highlights") else "")
        for f in files[:6]
    )
    return (
        f"The student is studying for: {json.dumps(p.get('assignment', {}))}\n\n"
        f"Their material:\n{blocks or '(no files attached — use the assignment description and course)'}\n\n"
        "Make flashcards a 9th grader would actually be tested on: terms, dates, "
        "people, cause→effect, 'why did X' — not trivia. Answers ≤ 25 words, exact "
        "names and numbers. Prioritize anything they highlighted. 10-20 cards. "
        'Reply JSON: {"cards": [{"q": "<question or term>", "a": "<answer>"}]}'
    ), ["cards"]


def build_practice_test(p):
    """A structured practice test (mcq / true-false / short answer / flashcard)
    from the student's files + highlights, in the same JSON shape the panel
    grades locally. `avoid` lists prompts already on the student's test so a
    'more questions' call doesn't repeat them; `topic` narrows the focus."""
    files = p.get("files") or []
    blocks = "\n\n".join(
        f"### {f.get('title','file')}\n{str(f.get('text',''))[:8000]}"
        + ("\nStudent highlights: " + json.dumps(f.get("highlights")) if f.get("highlights") else "")
        for f in files[:6]
    )
    count = max(3, min(int(p.get("count") or 10), 25))
    types = [t for t in (p.get("types") or []) if t in ("mcq", "tf", "short", "flashcard")] or ["mcq", "tf", "short"]
    topic = str(p.get("topic") or "").strip()
    avoid = [str(a)[:160] for a in (p.get("avoid") or [])][:60]
    harder = bool(p.get("harder"))
    return (
        f"The student is studying for: {json.dumps(p.get('assignment', {}))}\n\n"
        f"Their material:\n{blocks or '(no files attached -- use the assignment description, the course and what a 9th grader in that course is tested on)'}\n\n"
        + (f"Focus only on: {topic}\n" if topic else "")
        + (f"Do NOT repeat these questions (already on their test): {json.dumps(avoid)}\n" if avoid else "")
        + ("Make these HARDER than a first pass: application, compare/contrast, 'which of these would happen if', multi-step. Still fair.\n" if harder else "")
        + f"Write {count} practice-test questions of these types only: {', '.join(types)}. "
        "Mix the types. Test what a teacher would actually ask on the real test: "
        "understanding and application, not trivia. Prioritize anything the student highlighted. "
        "Rules: mcq has 4 choices, exactly one right, distractors are plausible mistakes from the same topic, "
        "no 'all of the above'; tf statements are unambiguous; short answers have ONE clear expected "
        "answer plus 1-3 accepted alternates; flashcard = term/definition for vocab. One idea per "
        "question. Explanation <= 20 words: why the answer is right or the trap. "
        'Reply JSON: {"title": "<<= 6 words>", "questions": ['
        '{"type":"mcq","question":"…","choices":["…","…","…","…"],"answer":<0-based index>,"explanation":"…"}, '
        '{"type":"tf","statement":"…","answer":true,"explanation":"…"}, '
        '{"type":"short","question":"…","answer":"…","accept":["…"],"explanation":"…"}, '
        '{"type":"flashcard","term":"…","definition":"…"}]}'
    ), ["questions"]


def build_study_plan(p):
    return (
        f"Now: {p.get('now')}\n"
        f"The test: {json.dumps(p.get('assignment', {}))}\n"
        f"Course topics/units (from the portal): {json.dumps(p.get('topics', []))}\n"
        f"Attached material (excerpts): {json.dumps([{'title': f.get('title'), 'text': str(f.get('text',''))[:1500]} for f in (p.get('files') or [])[:4]])}\n\n"
        "Spread the studying across the days between now and the test (one session "
        "per day, 15-40 min, last day = full self-quiz without notes). Spaced "
        "retrieval beats rereading: every session ends with recall from memory. "
        "Name the specific topic per day when the material shows it. "
        'Reply JSON: {"sessions": [{"day": "<today|Tue|Wed…>", "text": "<what to do, ≤18 words>", '
        '"deliverable": "<what exists after, ≤10 words>", "estMin": <int>}], "note": "<≤20 words: the one thing to prioritize>"}'
    ), ["sessions"]


def build_autopsy(p):
    return (
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
    files = p.get("files") or []
    files_block = ""
    if files:
        parts = []
        for f in files[:8]:
            hl = f.get("highlights") or []
            hl_txt = ""
            if hl:
                hl_txt = "\nThe student's highlights + notes on it:\n" + "\n".join(
                    f"  - \"{str(h.get('quote',''))[:200]}\"" + (f" — note: {str(h.get('note',''))[:300]}" if h.get("note") else "")
                    for h in hl[:30]
                )
            parts.append(
                f"### {f.get('title','file')} ({f.get('kind','file')}{', truncated' if f.get('truncated') else ''})\n"
                f"{str(f.get('text',''))[:14000]}{hl_txt}"
            )
        files_block = (
            "FILES ATTACHED TO THIS ASSIGNMENT (you can see these whatever tab the student is on):\n\n"
            + "\n\n".join(parts) + "\n\n"
        )
    dev = bool(p.get("devMode"))
    target = p.get("docTarget") or None
    can_write = dev and target and bool(p.get("googleConnected"))
    if can_write:
        write_block = (
            "DEVELOPER MODE — YOU CAN WRITE INTO THE STUDENT'S GOOGLE DOC. When they ask "
            "you to write, add, fix or format something IN the doc, do it: end your reply "
            "with a fenced block\n```docops\n{\"ops\": [...], \"summary\": \"<≤15 words>\"}\n```\n"
            "Allowed ops: {\"type\":\"append\",\"text\"} · {\"type\":\"replaceAll\",\"find\",\"replace\"} · "
            "{\"type\":\"insertAfter\",\"paragraph\":<i>,\"text\"} · {\"type\":\"replaceParagraph\",\"paragraph\":<i>,\"text\"} · "
            "{\"type\":\"deleteParagraph\",\"paragraph\":<i>} · {\"type\":\"setStyle\",\"paragraph\":<i>,\"style\":\"HEADING_2\"} · "
            "{\"type\":\"replaceBody\",\"text\"} (only for a full rewrite). Paragraph indexes count from 0 in the "
            "attached doc's text, one per line. Write finished prose, never placeholders. Say what you did "
            "in one line; the block does the writing. Never claim you can't write into the doc.\n\n"
        )
    elif dev:
        write_block = (
            "Doc writing: no Google Doc is attached to this assignment"
            + ("" if p.get("googleConnected") else " and Google isn't connected (⚙ → connect G)")
            + ", so you can't edit a doc in place -- write anything they ask for right here in the chat instead, "
            "finished and ready to paste, and mention '+ this tab' once if they want it inside the doc.\n\n"
        )
    else:
        write_block = (
            "You do not write into the student's documents (tutor, not ghostwriter). If asked, "
            "say what you'd put there and point them at the 'format my doc' chip for formatting.\n\n"
        )
    quiz_block = ""
    if p.get("quiz"):
        quiz_block = (
            "QUIZ MODE. You are quizzing the student for a test using the attached files "
            "and course topics. Rules: ONE question per message, then stop and wait. When they "
            "answer: grade it honestly (✓ or ✗ with the correct answer in one line and WHY), "
            "keep a running score like 'score 3/5', then ask the next question. Start easy, "
            "get harder; return to anything they missed later in a new form. Mix recall, "
            "why-questions and apply-it questions. After ~8 questions give a short summary: "
            "what's solid, what to restudy. Never answer your own question before they try.\n\n"
        )
    return (
        f"{_voice_block(p, for_chat=True) if p.get('devMode') or p.get('mode') == 'answer' else ''}"
        f"{quiz_block}"
        "What you can see (be accurate if asked): the student's assignments, grades "
        "and schedule from their school portal; the assignment they're working on, its "
        "checklist, and every FILE ATTACHED to it (readings, PDFs, their doc — with their "
        "highlights and notes); and, if a Google Doc is open in their active tab, its text. "
        "Attached files stay visible when they switch tabs. Nothing else on their screen.\n\n"
        f"{write_block}"
        f"{focus_block}"
        f"{files_block}"
        f"{_context_block(p)}"
        f"{doc_block}"
        f"The student's current assignments: {json.dumps(p.get('assignments', []))}\n"
        f"The student's stats: {json.dumps(p.get('stats', {}))}\n\n"
        f"Conversation so far:\n{transcript}\n\n"
        "Reply to the student's last message. "
        + (DEV_LENGTH if dev else LENGTH_CAP) +
        "Plain text with simple markdown allowed (**bold**, "
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
        f"{_context_block(p)}"
        f"Assignment (from the portal, instructions included): {json.dumps(a)}\n\n"
        f"Available resources -- you may ONLY reference these by their numbers:\n"
        f"Teacher links from the instructions: {json.dumps(res.get('links', []))}\n"
        f"This class's Blackbaud topics/modules: {json.dumps(res.get('topics', []))}\n"
        f"Google Docs connected: {bool(res.get('googleConnected'))}\n\n"
        "You are the student's hands for SETUP ONLY. Read the instructions and "
        "decide: which of the numbered resources should be opened right now "
        "(only ones the instructions actually call for or clearly need -- opening "
        "everything is noise). If you tell the student to have the module, a reading "
        "or a linked page ready, it MUST also be in opens -- saying 'open the module' "
        "without opening it is the one failure students notice. Then: whether a fresh Google Doc would help (essays/"
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
    "summarize": build_summarize,
    "annotateQuestion": build_annotate_question,
    "askPassage": build_ask_passage,
    "writeStep": build_write_step,
    "answerAll": build_answer_all,
    "readPhoto": build_read_photo,
    "readScreen": build_read_screen,
    "readPage": build_read_page,
    "videoSummary": build_video_summary,
    "editDoc": build_edit_doc,
    "flashcards": build_flashcards,
    "practiceTest": build_practice_test,
    "voiceProfile": build_voice_profile,
    "studyPlan": build_study_plan,
    "autopsy": build_autopsy,
    "chat": build_chat,
    "explain": build_explain,
    "precheck": build_precheck,
    "setup": build_setup,
    "debrief": build_debrief,
}


_client = None


def _api_client():
    global _client
    if _client is None:
        try:
            import anthropic  # pip3 install anthropic
        except ImportError as e:
            raise RuntimeError("API engine needs the SDK: pip3 install anthropic") from e
        _client = anthropic.Anthropic(api_key=_api_key(), timeout=CLAUDE_TIMEOUT, max_retries=2)
    return _client


def _images(image):
    """`image` may be one {"media_type","data"} dict, a list of them, or None."""
    if not image:
        return []
    return list(image) if isinstance(image, (list, tuple)) else [image]


def _complete_api(system: str, prompt: str, image=None) -> str:
    """One Claude API call. Thinking is adaptive by default on this model;
    effort is the latency knob. fallbacks='default' re-runs a classifier
    decline on another model server-side instead of surfacing a refusal.
    `image` = {"media_type": "image/jpeg", "data": "<base64>"} (or a list of
    them: video frames, in order) goes in as real image blocks so the model
    actually sees them (a photo of paper work, a screenshot, a PDF page)."""
    content = [{"type": "image", "source": {"type": "base64", "media_type": im["media_type"], "data": im["data"]}} for im in _images(image)]
    content.append({"type": "text", "text": prompt})
    resp = _api_client().messages.create(
        model=API_MODEL,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": content}],
        extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
        extra_body={"fallbacks": "default", "output_config": {"effort": API_EFFORT}},
    )
    if resp.stop_reason == "refusal":
        details = getattr(resp, "stop_details", None)
        _raise_refusal(getattr(details, "explanation", "") or "")
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()


def _raise_refusal(explanation: str = ""):
    """The provider's explanation of a refusal can quote the request; it is
    kept as detail (never sent, never logged) behind one fixed sentence."""
    raise CoachError(PUBLIC_DECLINED, detail=explanation)


def _complete_cli(system: str, prompt: str, image=None) -> str:
    """One headless `claude -p` call with our own system prompt, no tools, no
    session file, no settings, from an empty directory -- as close to a bare
    model call as Claude Code gets while still using the login.

    --setting-sources "" is the important one: with the user's settings.json
    loaded, Ben's SessionStart/Stop hooks ran inside EVERY coach call -- the
    Stop hook demanded an Obsidian log entry, so the reply the panel showed
    was often the model's 'Logged -- ...' note instead of the answer, and
    each call took 15s+ instead of ~3s. (--bare would also do it, but it skips
    keychain reads and so loses the login.)"""
    CLI_CWD.mkdir(parents=True, exist_ok=True)
    tools = ["--tools", ""]
    img_paths = []
    for i, im in enumerate(_images(image)):
        # claude -p can't take an image on stdin; drop it INSIDE the cwd and
        # let the model read it with the (read-only) Read tool -- the only tool
        # this call gets. Deleted right after.
        ext = "png" if im["media_type"] == "image/png" else "webp" if im["media_type"] == "image/webp" else "jpg"
        path = CLI_CWD / f"image-{int(time.time() * 1000)}-{i + 1}.{ext}"
        path.write_bytes(base64.b64decode(im["data"]))
        img_paths.append(path)
    if img_paths:
        tools = ["--tools", "Read", "--allowedTools", "Read"]
        listing = "\n".join(f"  {i + 1}. {pth}" for i, pth in enumerate(img_paths))
        prompt = (f"First, look at {'the image' if len(img_paths) == 1 else 'each of these images, in order,'} with your Read tool:\n{listing}\nThen:\n\n{prompt}")
    try:
        proc = subprocess.run(
            ["claude", "-p", "--model", MODEL, "--output-format", "json",
             "--system-prompt", system, *tools, "--no-session-persistence",
             "--setting-sources", ""],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=CLAUDE_TIMEOUT,
            cwd=str(CLI_CWD),
        )
    finally:
        for pth in img_paths:
            try:
                pth.unlink()
            except OSError:
                pass
    if proc.returncode != 0:
        raise CoachError(PUBLIC_BRAIN_DOWN, detail=proc.stderr[:200])
    return json.loads(proc.stdout).get("result", "").strip()


def _complete(system: str, prompt: str, image=None) -> str:
    return _complete_api(system, prompt, image) if ENGINE == "api" else _complete_cli(system, prompt, image)


def ask_claude_text(prompt: str, system: str = COACH_IDENTITY, image=None) -> str:
    """Run one Claude call and return the raw text reply."""
    text = _complete(system, prompt, image)
    # Only unwrap a reply that is ENTIRELY one fenced block. Stripping a trailing
    # fence unconditionally used to eat the closing ``` of a docops block at the
    # end of a reply, so the panel never saw it as a block.
    if text.startswith("```") and text.count("```") == 2 and text.endswith("```"):
        text = re.sub(r"^```(?:markdown|md)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text


def ask_claude(prompt: str, system: str = COACH_IDENTITY, image=None):
    """Run one Claude call and parse the JSON out of its reply."""
    text = _complete(system, prompt, image)
    # Claude was told JSON-only, but strip fences defensively.
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise CoachError(PUBLIC_BAD_REPLY, detail="no JSON object in reply")
    try:
        return _parse_json_lenient(match.group(0))
    except json.JSONDecodeError as e:
        raise CoachError(PUBLIC_BAD_REPLY, detail=str(e)[:100]) from e


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

    # Only the extension may talk to the bridge from a browser. Extension
    # pages send Origin: chrome-extension://<id>; web pages send their site,
    # which is refused. curl and the SDK send no Origin and are allowed
    # (they still need a code). Echoing the origin instead of "*" is what
    # makes the browser enforce this too.
    def _origin(self):
        return (self.headers.get("Origin") or "").strip()

    def _origin_ok(self):
        o = self._origin()
        return not o or o.startswith("chrome-extension://") or o in ALLOW_ORIGINS

    def _cors(self):
        o = self._origin()
        self.send_header("Access-Control-Allow-Origin", o if (o.startswith("chrome-extension://") or o in ALLOW_ORIGINS) else "null")
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-FA-Token")

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        try:
            self.end_headers()
            self.wfile.write(body)
        except BrokenPipeError:
            pass  # the panel gave up waiting (its own timeout) -- nothing to tell it

    def do_OPTIONS(self):
        self.send_response(204 if self._origin_ok() else 403)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def do_HEAD(self):
        # SimpleHTTPRequestHandler would otherwise answer HEAD for the repo directory.
        self.send_response(404)
        self.end_headers()

    def _who(self):
        """Name behind the request's access code; 'local' when auth is off
        (no codes configured AND bound to loopback); None = not allowed."""
        tok = (self.headers.get("X-FA-Token") or "").strip()
        if not tok:
            auth = self.headers.get("Authorization") or ""
            if auth.lower().startswith("bearer "):
                tok = auth[7:].strip()
        if tok and tok in TOKENS:
            return TOKENS[tok], False
        if not TOKENS and not HOSTED and self._is_loopback():
            return "local", True   # the developer's own open bridge: a connection property, not a name
        return None, False

    def _is_loopback(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    # The bridge is a long-lived process: edits to this file do nothing until
    # it's restarted. /health says so, and the panel shows it.
    STARTED = time.time()
    SOURCE = Path(__file__).resolve()

    def do_GET(self):
        if not self._origin_ok():
            return self._send_json(403, {"error": "only the Focus Agent extension may call this bridge"})
        if self.path == "/voice/local":
            # The student's own style guide + sample essays on this machine
            # (~/.claude/skills/essay). Read-only; nothing is uploaded anywhere.
            # Developer's own loopback bridge only: a hosted bridge (even one
            # behind a same-host reverse proxy) does not have this endpoint.
            if HOSTED:
                return self._send_json(404, {"error": "unknown endpoint"})
            if not self._is_loopback():
                return self._send_json(403, {"error": "voice import only works with a bridge on this computer"})
            base = Path.home() / ".claude" / "skills" / "essay"
            out = {"guide": "", "samples": []}
            try:
                skill = base / "SKILL.md"
                if skill.exists():
                    out["guide"] = skill.read_text(errors="ignore")[:12000]
                for f in sorted(base.rglob("*")):
                    if f.is_file() and f.suffix.lower() in (".md", ".txt") and f.name != "SKILL.md":
                        out["samples"].append({"title": f.stem, "text": f.read_text(errors="ignore")[:20000]})
            except Exception as e:  # noqa: BLE001
                out["error"] = str(e)[:200]
            return self._send_json(200, out)
        if self.path == "/health":
            try:
                mtime = self.SOURCE.stat().st_mtime
            except OSError:
                mtime = 0
            who, open_local = self._who()
            return self._send_json(200, {
                "ok": True, "brain": "claude", "engine": ENGINE,
                "hosted": HOSTED, "auth": bool(TOKENS), "who": who,
                "role": _role(who, open_local),   # the panel enables developer controls only when this says dev
                "model": API_MODEL if ENGINE == "api" else MODEL,
                "started": int(self.STARTED), "sourceMtime": int(mtime),
                "stale": mtime > self.STARTED,   # file edited since launch → restart me
                "methods": sorted(BUILDERS.keys()),
            })
        return self._send_json(404, {"error": "unknown endpoint"})

    def do_POST(self):
        if self.path != "/coach":
            return self._send_json(404, {"error": "unknown endpoint"})
        if not self._origin_ok():
            return self._send_json(403, {"error": "only the Focus Agent extension may call this bridge"})
        who, open_local = self._who()
        if who is None:
            return self._send_json(401, {"error": "access code missing or wrong (⚙ → coach server)"})
        role = _role(who, open_local)
        log_id = _pseud(who)
        # Request framing first: the length must be an honest positive number
        # under the cap, and the body must actually be that long. A negative
        # or missing length used to slip a full-size body past the cap.
        raw_len = (self.headers.get("Content-Length") or "").strip()
        if not raw_len.isdigit():
            return self._send_json(411, {"error": "bad request"})
        length = int(raw_len)
        if length < 2:
            return self._send_json(400, {"error": "bad request"})
        if length > MAX_BODY:
            return self._send_json(413, {"error": "that's too big to send the coach -- try a smaller screenshot or fewer files"})
        body = self.rfile.read(length)
        if len(body) != length:
            return self._send_json(400, {"error": "bad request"})
        if not _count_call(who):
            return self._send_json(429, {"error": f"daily limit reached ({DAILY_CAP} coach calls) — resets at midnight UTC"})
        t0 = time.time()
        method = "invalid-method"   # what the log says until the method is a registered name
        try:
            try:
                req = json.loads(body)
            except json.JSONDecodeError:
                return self._send_json(400, {"error": "bad request"})
            if not isinstance(req, dict) or not isinstance(req.get("method"), str) or req["method"] not in BUILDERS:
                return self._send_json(400, {"error": "unknown method"})
            method = req["method"]
            builder = BUILDERS[method]
            raw_payload = req.get("payload", {})
            if raw_payload is None:
                raw_payload = {}
            if not isinstance(raw_payload, dict):
                return self._send_json(400, {"error": "bad request"})
            # The student/developer boundary, before any prompt exists:
            # writing methods are developer-only, and every other method runs
            # with the client's devMode/mode flags forced to tutor for students.
            if method in DEV_ONLY_METHODS and role != "dev":
                print(f"[coach] {log_id} {method} refused (role {role})", flush=True)
                return self._send_json(403, {"error": "that's a developer-only action -- the coach explains and checks your work, it doesn't write it"})
            payload = _normalize_for_role(dict(raw_payload), role)
            # An image (photo of paper work, screenshot of the page) rides along
            # as a data URL; it goes to the model as a real image, never to disk
            # except for the claude -p engine's temp file.
            image = None
            data_url = payload.pop("imageDataUrl", "") or ""
            extra_urls = payload.pop("imageDataUrls", None)   # video frames, in order (cap MAX_IMAGES)
            urls = ([data_url] if data_url else []) + ([str(u) for u in extra_urls] if isinstance(extra_urls, list) else [])
            if len(urls) > MAX_IMAGES:
                return self._send_json(400, {"error": "too many images in one call"})
            images = []
            for u in urls:
                m = re.match(r"data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$", str(u), re.S)
                if not m:
                    return self._send_json(400, {"error": "that image couldn't be read -- try the screenshot again"})
                b64 = re.sub(r"\s+", "", m.group(2))
                try:
                    decoded = base64.b64decode(b64, validate=True)
                except (ValueError, base64.binascii.Error):
                    return self._send_json(400, {"error": "that image couldn't be read -- try the screenshot again"})
                if not decoded or len(decoded) > MAX_BODY:
                    return self._send_json(400, {"error": "that image couldn't be read -- try the screenshot again"})
                images.append({"media_type": "image/" + m.group(1).replace("jpg", "jpeg"), "data": b64})
            if images:
                image = images[0] if len(images) == 1 else images
            elif method in IMAGE_REQUIRED_METHODS:
                return self._send_json(400, {"error": f"{method} needs imageDataUrl"})
            if method == "videoSummary":
                payload["frames"] = len(images)
            prompt, required = builder(payload)
            system = _system(payload)
            if ENGINE == "mock":
                # Test engine: report what would have gone to the model, count it, send nothing.
                # _mockFail lets the harness drive the error paths without a provider.
                fail = payload.get("_mockFail")
                if fail == "refusal":
                    _raise_refusal("SYNTHETIC_PRIVATE_REFUSAL_SENTINEL " + str(payload.get("_sentinel", "")))
                if fail == "crash":
                    raise TypeError("SYNTHETIC_TRACEBACK_SENTINEL " + str(payload.get("_sentinel", "")))
                if fail == "badreply":
                    raise CoachError(PUBLIC_BAD_REPLY, detail="SYNTHETIC_DETAIL_SENTINEL")
                if MOCK_COUNT_FILE:
                    with _usage_lock:
                        n = int(MOCK_COUNT_FILE.read_text() or 0) + 1 if MOCK_COUNT_FILE.exists() else 1
                        MOCK_COUNT_FILE.write_text(str(n))
                return self._send_json(200, {"ok": True, "result": {
                    "mock": True, "method": method, "role": role,
                    "policy": "dev" if payload.get("devMode") else str(payload.get("mode") or "tutor"),
                    "devMode": bool(payload.get("devMode")), "mode": payload.get("mode"),
                    "system_is_dev": "DEVELOPER MODE" in system,
                    "prompt_offers_docops": "```docops" in prompt,
                    "prompt_asks_key_ideas": '"keyIdeas"' in prompt,   # the overview reply schema; the student prompt never asks for it
                    "prompt_asks_summary": '"summary"' in prompt,      # video: the summary schema; a graded-notes video never asks for it
                    "prompt_caps_length": "LENGTH CAP" in prompt,      # chat/askPassage: the default reply cap (dev-mode writing is exempt)
                    "images": len(_images(image)),
                    "prompt_has_voice": "VOICE RULE" in prompt or "OWN VOICE" in prompt,
                    "image": bool(image), "required": required,
                }})
            if method == "chat":
                reply = ask_claude_text(prompt, system, image)
                print(f"[coach] {log_id} chat {ENGINE} {int((time.time() - t0) * 1000)}ms ok", flush=True)
                return self._send_json(200, {"ok": True, "result": {"reply": reply}})
            result = ask_claude(prompt, system, image)
            missing = [k for k in required if k not in result]
            if missing:
                print(f"[coach] {log_id} {method} {ENGINE} incomplete reply", flush=True)
                return self._send_json(502, {"error": PUBLIC_BAD_REPLY})
            print(f"[coach] {log_id} {method} {ENGINE} {int((time.time() - t0) * 1000)}ms ok", flush=True)
            return self._send_json(200, {"ok": True, "result": result})
        except Exception as e:  # noqa: BLE001 -- report anything to the client, safely
            # The client gets a FIXED sentence (CoachError.public or the
            # generic one); the log gets the pseudonymous caller, the
            # registered method name and the error CLASS. Never str(e):
            # provider explanations and JSON errors quote the request.
            kind = type(e).__name__
            msg = e.public if isinstance(e, CoachError) else PUBLIC_GENERIC
            print(f"[coach] {log_id} {method} {ENGINE} {int((time.time() - t0) * 1000)}ms ERR {kind}", flush=True)
            return self._send_json(500 if not isinstance(e, CoachError) or e.public != PUBLIC_DECLINED else 422, {"error": msg})

    def log_message(self, fmt, *args):
        # Quieter logs: only /coach traffic.
        if "/coach" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "token":
        name = sys.argv[2]
        dev = len(sys.argv) >= 4 and sys.argv[3] == "dev"
        try:
            tok = mint_token(name, dev)
        except ValueError as e:
            sys.exit(f"can't mint a code: {e}")
        print(f"access code for {name}{' (developer role)' if dev else ''}: {tok}")
        print(f"(saved to {TOKENS_FILE}; restart the bridge to load it. Hosted on Fly? add it to FA_TOKENS instead.)")
        sys.exit(0)
    if HOSTED and not TOKENS:
        sys.exit("Refusing to start: FA_HOST is not loopback but no access codes are configured (FA_TOKENS or ~/.focus-agent/tokens).")
    if HOSTED and ENGINE not in ("api", "mock"):
        sys.exit("Refusing to start hosted without the API engine: claude -p has no login on a server and would give the model a file-reading tool. Set ANTHROPIC_API_KEY or put the key in ~/.focus-agent/api_key.")
    print(f"Focus Agent bridge on http://{HOST}:{PORT}  (auth: {len(TOKENS)} access code(s), cap {DAILY_CAP}/day each)" if TOKENS
          else f"Focus Agent bridge on http://{HOST}:{PORT}  (open: local use only)", flush=True)
    if ENGINE == "api":
        print(f"  coach brain : Claude API (model={API_MODEL}, effort={API_EFFORT})")
    else:
        print(f"  coach brain : claude -p (headless, model={MODEL}) -- no API key found")
        print(f"                put one in {API_KEY_FILE} (or export ANTHROPIC_API_KEY) for the fast engine")
    # ThreadingHTTPServer matters: brain calls take 15s+, and a single-threaded
    # server would queue the panel's 1.5s health checks behind them.
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
