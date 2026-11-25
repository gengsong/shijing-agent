---
name: shijing-ux-check
description: After changing a user-facing web flow (moving a button, reworking a menu, a form or an export path), measure whether the task got easier. Runs the same task on the old and new version with the shijing MCP tools and reports clicks, path and whether the output is identical. Use when the user asks if a UI change is an improvement, or before claiming one.
---

# UX check with shijing

Use this when a change touches how a user gets something done on a web page. Use it before you say "this is easier now", not after.

## 1. Pin down the task

- Write the **goal** the way a user would ask for it: "Export the task list as a CSV file". Do not write UI steps like "click More, then Export".
- Choose an **independent check** that proves the task is done:
  - the task downloads a file → `download_name` (e.g. `"*.csv"`), plus `expected_file` if you have a known-good file;
  - the task shows something → `success_text`, text that only appears when the task is complete.
- If you can't name a check, ask the user. Never fall back to "it looked right".

## 2. Get both versions running

- **baseline**: the version before the change. Use a URL (staging, a preview deploy, a local server on another port) or a built HTML file. If it only exists in git, check out the old commit into a separate worktree and serve that; do not overwrite the user's working tree.
- **candidate**: the version with the change.
- Only use sites the user owns or is allowed to test.

## 3. Run the comparison

Call the `compare_pages` tool:

```json
{
  "goal": "Export the task list as a CSV file",
  "baseline": "http://localhost:3000/checklist",
  "candidate": "http://localhost:3001/checklist",
  "download_name": "*.csv",
  "expected_file": "fixtures/checklist.csv"
}
```

The default planner is `rules`, which is offline and free. Use `planner: "claude"` when the wording is fuzzy or the flow needs typing. It needs `ANTHROPIC_API_KEY` in the MCP server's environment and costs money, so tell the user before you use it.

For a task the project already keeps as YAML, call `run_task_file` instead.

## 4. Report honestly

Quote the numbers from the result, not your impression:

- Did both versions pass? If the candidate fails and the baseline passes, that is a **regression**. Say so first.
- Clicks before → after, and the path each one took.
- Does the output match (sha256)? Fewer clicks with a different file is not an improvement.
- Link the `report.md` path from the JSON summary.

If a run fails, show the `reason` from the summary and fix the cause (wrong check, page not running, control behind a sign-in) before running again. Do not tune the goal wording until the candidate passes.

## Limits

The agent never presses buy, delete, sign-in or out, upload, publish or send, and it blocks non-GET requests. Flows that need those are outside what this check can measure, so tell the user instead of working around it.
