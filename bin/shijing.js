#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTask, TaskError } from '../src/task.js';
import { runTask } from '../src/run.js';
import { renderMarkdown, compare } from '../src/report.js';
import { createRulesPlanner } from '../src/planners/rules.js';

const HELP = `shijing — did your redesign make the task easier?

Usage
  shijing demo [options]           Run the bundled example (old vs new checklist page)
  shijing run <task.yaml> [options]

Options
  --target <name>     Run only this target (repeatable). Default: all, in file order.
  --planner <name>    rules (default, offline) | claude (needs ANTHROPIC_API_KEY)
  --model <id>        Claude model for --planner claude (default: claude-opus-5-5)
  --out <dir>         Where to write report.md, result.json, downloads and screenshots.
                      Default: .shijing/runs/<timestamp>
  --headed            Show the browser window.
  --video             Record a video of each target (with the agent's clicks highlighted).
  --slow-mo <ms>      Slow every browser action down, e.g. for recordings.
  --chrome            Use your installed Google Chrome instead of bundled Chromium.
  --json              Print result.json to stdout instead of the Markdown report.
  -h, --help          Show this help.

Exit codes
  0  every target passed     1  a target failed     2  invalid task or options
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: 'string', multiple: true },
      planner: { type: 'string', default: 'rules' },
      model: { type: 'string' },
      out: { type: 'string' },
      headed: { type: 'boolean', default: false },
      video: { type: 'boolean', default: false },
      'slow-mo': { type: 'string', default: '0' },
      chrome: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command] = positionals;
  let [, taskFile] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'demo') {
    taskFile = fileURLToPath(new URL('../examples/export-csv/task.yaml', import.meta.url));
  } else if (command !== 'run' || !taskFile) {
    process.stderr.write(`Unknown command. Try: shijing demo\n`);
    return 2;
  }
  const slowMo = Number(values['slow-mo']);
  if (!Number.isInteger(slowMo) || slowMo < 0 || slowMo > 5000) {
    process.stderr.write('--slow-mo must be a whole number of milliseconds (0-5000).\n');
    return 2;
  }

  const task = await loadTask(taskFile);

  let plannerFactory;
  if (values.planner === 'rules') {
    plannerFactory = createRulesPlanner;
  } else if (values.planner === 'claude') {
    const { createClaudePlanner } = await import('../src/planners/claude.js');
    plannerFactory = () => createClaudePlanner({ model: values.model });
  } else {
    process.stderr.write(`Unknown planner "${values.planner}". Use rules or claude.\n`);
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(values.out ?? path.join('.shijing', 'runs', stamp));
  const log = (msg) => { if (!values.json) process.stderr.write(msg + '\n'); };

  log(`▶ ${task.name}`);
  const run = await runTask({
    task,
    targets: values.target,
    plannerFactory,
    outDir,
    headed: values.headed,
    channel: values.chrome ? 'chrome' : undefined,
    video: values.video,
    slowMo,
    onStep: (target, s) => log(`  [${target}] ${s.step}. ${s.action} "${s.label}"`),
  });

  const md = renderMarkdown(run);
  await writeFile(path.join(outDir, 'report.md'), md);

  if (values.json) {
    process.stdout.write(JSON.stringify(run, null, 2) + '\n');
  } else {
    for (const r of run.results) log(`  [${r.target}] ${r.status} · ${r.clicks} click(s) · ${r.reason}`);
    const verdict = compare(run.results);
    if (verdict) log(`\n${verdict.replace(/`/g, '')}`);
    log(`\nReport: ${path.relative(process.cwd(), path.join(outDir, 'report.md'))}`);
  }
  return run.results.every((r) => r.status === 'passed') ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e instanceof TaskError ? '' : 'Error: '}${e.message}\n`);
    process.exit(e instanceof TaskError ? 2 : 1);
  },
);
