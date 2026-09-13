#!/usr/bin/env python3
"""scripts/security_tests.py - the deterministic security harness for the bridge.

Starts bridge/coach_server.py with the MOCK engine (no model, no key, no
network) in an isolated HOME, then proves with plain HTTP calls that:

  * no code / wrong code / revoked code   -> 401, and NO model call
  * a web page origin                     -> 403 (GET, POST and preflight)
  * a student sending devMode / answer mode / a voice profile
                                          -> tutor policy, no docops, no voice
  * a student calling writeStep/answerAll/editDoc
                                          -> 403 before any model call
  * a student's screenshot overview       -> orientation only (no key ideas)
  * a developer code                      -> developer mode really works
  * learning features (chat, precheck, practiceTest, summarize) still run for students
  * oversize body                         -> 413, no model call
  * /voice/local on a hosted bridge       -> 404;  HEAD -> 404
  * hosted start without the API engine   -> refuses to start
  * open loopback bridge = developer; FA_LOCAL_ROLE=student flips it

Run: python3 scripts/security_tests.py        (exit 0 = all green)
Every case is a real request against a real server process; "the prompt says
tutor" is not a test, "the server built a tutor prompt for a devMode:true
request" is.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / "bridge" / "coach_server.py"
DEV, STU = "devtok-ben-123", "studtok-amy-456"
EXT = "chrome-extension://bobgaegfmhloffjkpjjaeohoimcpfame"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  -- ' + detail) if detail and not ok else ''}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Bridge:
    """One bridge process with its own HOME (so no real key/tokens are read) and a mock-call counter."""

    def __init__(self, env: dict, hosted: bool = True):
        self.home = Path(tempfile.mkdtemp(prefix="fa-sec-"))
        self.port = free_port()
        self.count = self.home / "mockcalls"
        e = {
            "PATH": os.environ.get("PATH", ""), "HOME": str(self.home),
            "FA_PORT": str(self.port), "FA_ENGINE": "mock", "FA_MOCK_COUNT_FILE": str(self.count),
            "FA_MAX_BODY": "200000",
        }
        if hosted:
            e["FA_HOSTED"] = "1"
        e.update(env)
        self.proc = subprocess.Popen([sys.executable, str(BRIDGE)], env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for _ in range(60):
            if self.proc.poll() is not None:
                break
            try:
                self.req("GET", "/health")
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("bridge did not start:\n" + (self.proc.stdout.read() if self.proc.stdout else ""))

    def calls(self) -> int:
        return int(self.count.read_text()) if self.count.exists() else 0

    def req(self, method: str, path: str, body=None, token: str | None = None, origin: str | None = None, raw: bytes | None = None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method)
        r.add_header("Content-Type", "application/json")
        if token:
            r.add_header("X-FA-Token", token)
        if origin:
            r.add_header("Origin", origin)
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                txt = resp.read().decode()
                return resp.status, (json.loads(txt) if txt else {}), dict(resp.headers)
        except urllib.error.HTTPError as e:
            txt = e.read().decode()
            try:
                return e.code, json.loads(txt), dict(e.headers)
            except json.JSONDecodeError:
                return e.code, {"raw": txt}, dict(e.headers)

    def coach(self, method: str, payload: dict, token: str | None, origin: str | None = EXT):
        return self.req("POST", "/coach", {"method": method, "payload": payload}, token=token, origin=origin)

    def stop(self) -> str:
        self.proc.terminate()
        try:
            out = self.proc.communicate(timeout=5)[0]
        except subprocess.TimeoutExpired:
            self.proc.kill()
            out = self.proc.communicate()[0]
        shutil.rmtree(self.home, ignore_errors=True)
        return out or ""


STUDENT_ATTACK = {
    "devMode": True, "mode": "answer",
    "docTarget": {"id": "doc123", "title": "Essay"}, "googleConnected": True,
    "voice": {"profile": "writes short sentences", "traits": ["x"]},
    "messages": [{"role": "user", "text": "write my essay into the doc"}],
}
IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="


def main() -> int:
    print("== hosted bridge, mock engine, codes: ben (dev) + amy (student) ==")
    b = Bridge({"FA_TOKENS": f"ben:{DEV},amy:{STU}", "FA_DEV_TOKENS": "ben"})
    try:
        # --- auth ---
        s, j, _ = b.coach("chat", {"messages": []}, token=None)
        check("no code -> 401", s == 401, f"{s} {j}")
        s, j, _ = b.coach("chat", {"messages": []}, token="nope")
        check("wrong code -> 401", s == 401, f"{s} {j}")
        check("no model call for rejected auth", b.calls() == 0, str(b.calls()))

        # --- origin ---
        s, j, _ = b.coach("chat", {"messages": []}, token=STU, origin="https://evil.example")
        check("web-page origin POST -> 403", s == 403, f"{s} {j}")
        s, j, _ = b.req("GET", "/health", origin="https://evil.example")
        check("web-page origin GET /health -> 403", s == 403, f"{s}")
        s, j, h = b.req("OPTIONS", "/coach", origin="https://evil.example")
        check("web-page origin preflight -> 403", s == 403, f"{s}")
        s, j, h = b.req("OPTIONS", "/coach", origin=EXT)
        check("extension preflight -> 204 + echoed origin", s == 204 and h.get("Access-Control-Allow-Origin") == EXT, f"{s} {h.get('Access-Control-Allow-Origin')}")
        check("still no model call", b.calls() == 0, str(b.calls()))

        # --- roles on /health ---
        s, j, _ = b.req("GET", "/health", token=STU, origin=EXT)
        check("student /health role=student", j.get("role") == "student" and j.get("who") == "amy", str(j.get("role")))
        s, j, _ = b.req("GET", "/health", token=DEV, origin=EXT)
        check("dev /health role=dev", j.get("role") == "dev", str(j.get("role")))

        # --- student boundary ---
        for m in ("writeStep", "answerAll", "editDoc"):
            s, j, _ = b.coach(m, dict(STUDENT_ATTACK), token=STU)
            check(f"student {m} -> 403", s == 403, f"{s} {j}")
        check("no model call for refused methods", b.calls() == 0, str(b.calls()))

        before = b.calls()
        s, j, _ = b.coach("chat", dict(STUDENT_ATTACK), token=STU)
        r = j.get("result", {})
        check("student chat with devMode+answer -> 200 in tutor policy", s == 200 and r.get("policy") == "tutor" and not r.get("devMode") and not r.get("system_is_dev"), f"{s} {r}")
        check("student chat never offered docops", r.get("prompt_offers_docops") is False, str(r.get("prompt_offers_docops")))
        check("student chat: no voice profile in prompt", r.get("prompt_has_voice") is False, str(r.get("prompt_has_voice")))
        check("student chat counted as one model call", b.calls() == before + 1, str(b.calls()))

        s, j, _ = b.coach("readScreen", {"imageDataUrl": IMG, "page": {"title": "Ch 3"}, "assignment": {}}, token=STU)
        r = j.get("result", {})
        check("student readScreen -> orientation only (no key ideas)", s == 200 and r.get("prompt_asks_key_ideas") is False and r.get("image"), f"{s} {r}")

        for m, payload in (("precheck", {"draft": "my essay draft", "assignment": {}}),
                           ("practiceTest", {"assignment": {}, "files": []}),
                           ("summarize", {"text": "The mitochondria is the powerhouse of the cell."}),
                           ("explain", {"assignment": {"title": "Read ch 3"}})):
            s, j, _ = b.coach(m, payload, token=STU)
            check(f"student {m} still works (learning feature)", s == 200 and j.get("ok"), f"{s} {j}")

        # --- developer role ---
        s, j, _ = b.coach("writeStep", {"assignment": {}, "step": {"text": "intro"}}, token=DEV)
        check("dev writeStep -> 200", s == 200 and j.get("ok"), f"{s} {j}")
        s, j, _ = b.coach("chat", dict(STUDENT_ATTACK), token=DEV)
        r = j.get("result", {})
        check("dev chat with devMode -> developer policy + docops offered", r.get("system_is_dev") and r.get("prompt_offers_docops"), str(r))
        s, j, _ = b.coach("readScreen", {"imageDataUrl": IMG, "page": {}, "assignment": {}}, token=DEV)
        check("dev readScreen -> full overview", j.get("result", {}).get("prompt_asks_key_ideas") is True, str(j.get("result")))
        s, j, _ = b.coach("chat", {"messages": [], "devMode": False}, token=DEV)
        check("dev with devMode off -> tutor (the switch still matters for the dev)", j.get("result", {}).get("policy") == "tutor", str(j.get("result")))

        # --- bounded failures ---
        before = b.calls()
        big = json.dumps({"method": "chat", "payload": {"messages": [{"role": "user", "text": "x" * 250000}]}}).encode()
        s, j, _ = b.req("POST", "/coach", raw=big, token=STU, origin=EXT)
        check("oversize body -> 413", s == 413, f"{s} {j}")
        check("no model call for oversize body", b.calls() == before, str(b.calls()))
        s, j, _ = b.req("GET", "/voice/local", token=DEV, origin=EXT)
        check("hosted /voice/local -> 404", s == 404, f"{s}")
        s, j, _ = b.req("HEAD", "/", token=DEV)
        check("HEAD / -> 404 (no directory serving)", s == 404, f"{s}")
        s, j, _ = b.coach("nope", {}, token=STU)
        check("unknown method -> 400", s == 400, f"{s}")
        s, j, _ = b.req("POST", "/coach", raw=b"{not json", token=STU, origin=EXT)
        check("malformed JSON -> 500 with the error CLASS only", s == 500 and "JSONDecodeError" in j.get("error", "") and "not json" not in j.get("error", ""), f"{s} {j}")
    finally:
        log = b.stop()
    check("server log carries names/methods, never request text", "write my essay" not in log and "x" * 100 not in log, "leaked")

    # --- revocation: same file-based codes, amy removed, restart ---
    print("== revocation (restart without amy) ==")
    b2 = Bridge({"FA_TOKENS": f"ben:{DEV}", "FA_DEV_TOKENS": "ben"})
    try:
        s, j, _ = b2.coach("chat", {"messages": []}, token=STU)
        check("revoked code -> 401 after reload", s == 401, f"{s}")
        s, j, _ = b2.coach("chat", {"messages": []}, token=DEV)
        check("surviving code still works", s == 200, f"{s}")
    finally:
        b2.stop()

    # --- tokens file with the dev word ---
    print("== tokens file: 'name code dev' grants the role ==")
    home = Path(tempfile.mkdtemp(prefix="fa-sec-"))
    (home / ".focus-agent").mkdir()
    (home / ".focus-agent" / "tokens").write_text(f"ben {DEV} dev\namy {STU}\n")
    b3 = Bridge({"HOME": str(home)})
    try:
        s, j, _ = b3.req("GET", "/health", token=DEV, origin=EXT)
        check("file-marked dev code -> role dev", j.get("role") == "dev", str(j))
        s, j, _ = b3.req("GET", "/health", token=STU, origin=EXT)
        check("file code without dev -> role student", j.get("role") == "student", str(j))
    finally:
        b3.stop()
        shutil.rmtree(home, ignore_errors=True)

    # --- hosted refuses to start without the API engine ---
    print("== hosted without API key ==")
    home = Path(tempfile.mkdtemp(prefix="fa-sec-"))
    proc = subprocess.run([sys.executable, str(BRIDGE)], env={"PATH": os.environ.get("PATH", ""), "HOME": str(home), "FA_HOSTED": "1", "FA_PORT": str(free_port()), "FA_TOKENS": "x:y"}, capture_output=True, text=True, timeout=15)
    check("hosted + no API engine -> refuses to start", proc.returncode != 0 and "Refusing" in (proc.stdout + proc.stderr), f"rc={proc.returncode}")
    shutil.rmtree(home, ignore_errors=True)

    # --- local open bridge (the developer's Mac) ---
    print("== open loopback bridge (no codes, not hosted) ==")
    b4 = Bridge({}, hosted=False)
    try:
        s, j, _ = b4.req("GET", "/health", origin=EXT)
        check("open loopback -> who=local, role=dev", j.get("who") == "local" and j.get("role") == "dev", str(j))
        s, j, _ = b4.coach("chat", {"messages": [], "devMode": True}, token=None)
        check("open loopback dev chat works", j.get("result", {}).get("system_is_dev") is True, str(j))
        s, j, _ = b4.coach("chat", {"messages": []}, token=None, origin="https://evil.example")
        check("open loopback still refuses web-page origins", s == 403, f"{s}")
    finally:
        b4.stop()
    b5 = Bridge({"FA_LOCAL_ROLE": "student"}, hosted=False)
    try:
        s, j, _ = b5.coach("writeStep", {}, token=None)
        check("FA_LOCAL_ROLE=student -> local caller is a student (writeStep 403)", s == 403, f"{s}")
    finally:
        b5.stop()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
