// End-to-end: real browser, real downloads. Needs Chromium (npx playwright install chromium) or Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTask } from '../src/task.js';
import { runTask } from '../src/run.js';
import { createRulesPlanner } from '../src/planners/rules.js';

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'export-csv');
const run = async (file) => runTask({
  task: await loadTask(path.join(examples, file)),
  plannerFactory: createRulesPlanner,
  outDir: await mkdtemp(path.join(tmpdir(), 'shijing-e2e-')),
});

test('export demo: 5 clicks on v1, 1 click on v2, identical CSV', { timeout: 120_000 }, async () => {
  const { results: [v1, v2] } = await run('task.yaml');
  assert.equal(v1.status, 'passed', v1.reason);
  assert.equal(v2.status, 'passed', v2.reason);
  assert.equal(v1.clicks, 5);
  assert.equal(v2.clicks, 1);
  assert.equal(v1.output.sha256, v2.output.sha256);
});

test('control: a wrong expected file makes both versions fail', { timeout: 120_000 }, async () => {
  const { results } = await run('task.control.yaml');
  for (const r of results) {
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /differs/);
  }
});
