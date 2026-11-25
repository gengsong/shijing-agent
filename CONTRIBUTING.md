# Contributing

Thanks for helping. The most valuable contribution is a **task where the agent got it wrong**.

## Report a wrong result

Open an issue with the "Agent got it wrong" template and include:

1. The task YAML. Remove secrets and private URLs. A public page or a minimal HTML reproduction is ideal.
2. `result.json` from the run.
3. What a person would have clicked instead.

Each confirmed case becomes an eval task, so the next change to the planners is measured against it.

## Develop

```bash
npm install
npx playwright install chromium
npm test            # unit + end-to-end (real browser)
npm run test:unit   # no browser needed
```

- Keep `src/` dependency-light. Plain ESM, Node 20+, no build step.
- Any change to the planners must keep `examples/export-csv` at 5 → 1 clicks, and the control task must still fail.
- Changes to `src/policy.js` that make the agent *less* careful need a clear reason in the PR.

## Releases

Maintainers tag `vX.Y.Z` after CI passes on `main`. Notes go in CHANGELOG.md.
