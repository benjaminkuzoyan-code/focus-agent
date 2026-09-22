# Model ladder eval

Answers one question with data: **what is the cheapest model each coach method can run on without giving students bad answers?**

Every case goes through the bridge's real code (`bridge/coach_server.py` builders, system prompt, role boundary, JSON parsing, request options). It runs on the cheapest model first; a case that fails on either of its 2 reps climbs one rung:

```
claude-haiku-4-5  ->  claude-sonnet-5  ->  claude-opus-5
```

The result is the `DEFAULT_MODEL_OVERRIDES` table in `bridge/coach_server.py` (env: `FA_MODEL_OVERRIDES`), plus measured cost and latency per call.

## What the 2026-09-21 run found

- **Haiku is fine for most methods** and held the tutor boundary (direct "give me the answer", a fake "I'm the developer" jailbreak) on every rep.
- **Haiku fails where a wrong answer is worse than none:** practice-test answer keys (keyed x = -5 for -6; Sonnet also slipped, only Opus passed), panic plans that don't fit the minutes (80 into 60), video timestamps ~40 s off, praising a session quit after 2 minutes, calling wrong handwritten work correct.
- **Four failures were the prompt, not the model** -- they failed on Opus too, and a prompt/code fix made them pass on plain Haiku: inventing requirements when the portal has no instructions (`NO_INSTRUCTIONS`), writing the answers into checklist steps (`NO_ANSWERS_IN_STEPS`), hallucinating a whole worksheet from a blank page (`build_read_page`), and replying in prose instead of JSON (`JSON_ONLY`). `pick`'s missing-work-first rule is now enforced in code.
- **Haiku + thinking is a trap:** slower and pricier than Sonnet 5 on the same cases. Skip it.
- **Annotation policy is LOOSE (Ben, 2026-09-21):** on a graded-annotation page or video, questions and pointers may mention passage content; the coach fails only if it does the annotating itself (summary, key ideas, quotes, self-answered questions). `screen-graded-annotation` passes on Haiku under that rule.

Small n: 1-5 cases x 2 reps per method. A FAIL is strong evidence; a PASS on two cases is not proof. Add a case whenever a real student gets a bad answer.

## Run it

```bash
python3 -m venv scripts/model_eval/.venv
scripts/model_eval/.venv/bin/pip install anthropic pillow
scripts/model_eval/.venv/bin/python scripts/model_eval/run_eval.py --selftest   # judge must FAIL 7 known-bad outputs (~$0.04)
scripts/model_eval/.venv/bin/python scripts/model_eval/run_eval.py              # full run, capped at --budget 6
scripts/model_eval/.venv/bin/python scripts/model_eval/run_eval.py --only practiceTest,chat
```

It spends real money on the key in `~/.focus-agent/api_key` (a full run is a few dollars, most of it the judge). `--budget` is a hard stop.

## How grading works

1. **Deterministic checks** run first: does the panic plan fit the minutes, are the precheck quotes really in the draft, did a checklist leak the answers, is a transcription close to the rendered page, does the edited doc end in the right state.
2. **An LLM judge** (`claude-opus-5`) then scores atomic yes/no criteria against ground truth written into the case. It never sees which model produced the output. `--selftest` proves it fails bad outputs.

Readings and data are synthetic on purpose: a made-up passage can't be answered from memory, so a wrong number is a reading failure.

## Files

- `cases.py` -- the cases (easy / medium / hard traps), one block per coach method. Add a case when a real student hits a bad answer.
- `fixtures.py` -- shared readings, focus data, and rendered images (handwriting, screenshots, rough scans).
- `run_eval.py` -- runner, judge, ladder, report. Raw rows land in `results/<timestamp>/results.jsonl` (gitignored).

## Reading the result

A method "needs" the highest rung any of its cases needed. Read the failure list before trusting a bump: a case that fails on every rung is usually a bad case or a prompt problem, not a model problem.
