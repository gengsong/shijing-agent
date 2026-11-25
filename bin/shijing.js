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
  shijing mcp                       Start the MCP server on stdio (for Claude Code, Claude Desktop, Cursor...)
  shijing setup [--yes] [--dry-run] [--remove] [--client <name>]
                                    Connect shijing to Claude Code, Claude Desktop, Cursor and Codex

Options
  --target <name>     Run only this target (repeatable). Default: all, in file order.
  --planner <name>    rules (default, offline) | claude (needs ANTHROPIC_API_KEY)
  --model <id>        Claude model for --planner claude. Default: claude-sonnet-5-5, and a target
                      that Sonnet does not finish is re-run with claude-opus-5-5.
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
      yes: { type: 'boolean', short: 'y', default: false },
      'dry-run': { type: 'boolean', default: false },
      remove: { type: 'boolean', default: false },
      client: { type: 'string', multiple: true },
    },
  });

  const [command] = positionals;
  let [, taskFile] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'setup') return setup(values);
  if (command === 'mcp') {
    const { startStdioServer } = await import('../src/mcp.js');
    await startStdioServer();
    return null; // keep running until the client disconnects
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

  let plannerTiers;
  if (values.planner === 'rules') {
    plannerTiers = [createRulesPlanner];
  } else if (values.planner === 'claude') {
    const { createClaudePlanner, claudeTiers } = await import('../src/planners/claude.js');
    plannerTiers = values.model ? [() => createClaudePlanner({ model: values.model })] : claudeTiers();
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
    plannerTiers,
    outDir,
    headed: values.headed,
    channel: values.chrome ? 'chrome' : undefined,
    video: values.video,
    slowMo,
    onStep: (target, s) => log(`  [${target}] ${s.step}. ${s.action} "${s.label}"`),
    onEscalate: (target, planner, reason) => log(`  [${target}] ${planner} did not finish (${reason}), retrying with the next model`),
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

async function setup(values) {
  const { planSetup, formatPlan, applyPlan } = await import('../src/setup.js');
  const plan = await planSetup({ only: values.client, remove: values.remove });
  const changes = plan.steps.filter((s) => ['add', 'update', 'remove'].includes(s.status));

  process.stdout.write(`shijing setup${values.remove ? ' --remove' : ''}\n\n${formatPlan(plan) || '  No supported agent found.'}\n\n`);
  if (!plan.steps.length) {
    process.stdout.write('Supported: Claude Code, Claude Desktop, Cursor, Codex. Use --client <name> to set one up anyway.\n');
    return 1;
  }
  if (!changes.length) {
    process.stdout.write('Nothing to change.\n');
    return 0;
  }
  if (values['dry-run']) return 0;

  if (!values.yes) {
    if (!process.stdin.isTTY) {
      process.stdout.write('Re-run with --yes to apply these changes.\n');
      return 1;
    }
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Apply ${changes.length} change(s)? Existing config files are backed up first. [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write('Nothing changed.\n');
      return 1;
    }
  }

  const results = await applyPlan(plan);
  for (const r of results) {
    process.stdout.write(`  ${r.ok ? '✓' : '✗'} ${r.client} ${r.kind}${r.ok ? '' : `: ${r.error}`}\n`);
  }
  const failed = results.filter((r) => !r.ok).length;
  if (!values.remove && !failed) {
    process.stdout.write('\nRestart your agent, then ask it: "I changed the export flow. Use shijing to check if it got easier."\n');
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => { if (code !== null) process.exit(code); },
  (e) => {
    process.stderr.write(`${e instanceof TaskError ? '' : 'Error: '}${e.message}\n`);
    process.exit(e instanceof TaskError ? 2 : 1);
  },
);
