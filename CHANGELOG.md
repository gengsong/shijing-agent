# Changelog

## 0.1.0 (2026-11-25)

- `shijing mcp`: MCP server on stdio with `compare_pages`, `run_task_file` and `run_demo`
- Claude planner tries Sonnet 5.5 first and re-runs a target with Opus 5.5 if Sonnet doesn't finish; the report shows the chain and summed cost
- `shijing demo` runs the bundled example; `--video` and `--slow-mo` record each version with clicks highlighted

- `shijing run` CLI with baseline / candidate comparison and Markdown + JSON reports
- Rules planner (offline) and Claude planner (bring your own key)
- Independent success checks: downloaded file (name + bytes) and page text
- Safety policy: risky controls skipped, non-GET requests blocked, same-origin navigation
- Example: release checklist export, 5 clicks → 1 click with identical CSV, plus a must-fail control task
