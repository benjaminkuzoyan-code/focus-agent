---
schema_version: 1
open_count: 0
waived_count: 1
fixed_count: 0
total_count: 1
last_updated: 2026-09-24T23:28:44.297Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 01 | deviation | package.json |  | Bundled runtime has Node but no npm; exact main test command executed directly and passed. | waived | Environment-only tooling difference: the exact package.json test chain passed; bundled pnpm is also available. No product defect or missing validation. | 2026-09-24T23:27:54.575Z | 2026-09-24T23:28:44.297Z |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "01",
    "file": "package.json",
    "line": null,
    "description": "Bundled runtime has Node but no npm; exact main test command executed directly and passed.",
    "status": "waived",
    "reason": "Environment-only tooling difference: the exact package.json test chain passed; bundled pnpm is also available. No product defect or missing validation.",
    "recorded_at": "2026-09-24T23:27:54.575Z",
    "resolved_at": "2026-09-24T23:28:44.297Z",
    "milestone": "v0.8.21"
  }
]
````
