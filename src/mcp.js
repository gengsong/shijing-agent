import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadTask, normalizeTask } from './task.js';
import { runTask, VERSION } from './run.js';
import { renderMarkdown, compare } from './report.js';
import { createRulesPlanner } from './planners/rules.js';

/**
 * MCP server: lets an agent (Claude Code, Claude Desktop, Cursor, ...) ask
 * "did this redesign make the task easier?" and get the comparison back.
 *
 * Runs over stdio. Nothing is written to stdout except protocol messages.
 */

const DEMO_TASK = fileURLToPath(new URL('../examples/export-csv/task.yaml', import.meta.url));

const plannerArgs = {
  planner: z.enum(['rules', 'claude']).optional()
    .describe('rules (default): offline and free. claude: needs ANTHROPIC_API_KEY in the server environment; tries Sonnet first and re-runs a target with Opus if Sonnet does not finish.'),
  model: z.string().optional().describe('Pin one Claude model instead of Sonnet→Opus escalation, e.g. claude-opus-5-5.'),
};

async function plannerTiers({ planner = 'rules', model }) {
  if (planner === 'rules') return [createRulesPlanner];
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('planner "claude" needs ANTHROPIC_API_KEY in the MCP server environment. Use planner "rules" or add the key to the server config.');
  }
  const { createClaudePlanner, claudeTiers } = await import('./planners/claude.js');
  return model ? [() => createClaudePlanner({ model })] : claudeTiers();
}

function outDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.resolve(process.env.SHIJING_OUT_DIR ?? path.join('.shijing', 'runs'), stamp);
}

/** Markdown for people, a compact JSON summary for the calling agent. */
function toToolResult(run, dir) {
  const summary = {
    verdict: compare(run.results),
    report: path.join(dir, 'report.md'),
    results: run.results.map((r) => ({
      target: r.target,
      status: r.status,
      clicks: r.clicks,
      path: r.steps.map((s) => s.label),
      output: r.output ? { name: r.output.name, bytes: r.output.bytes, sha256: r.output.sha256 } : null,
      reason: r.reason,
      planner: r.attempts ? r.attempts.map((a) => `${a.planner}:${a.status}`) : r.planner,
    })),
  };
  return {
    content: [
      { type: 'text', text: renderMarkdown(run) },
      { type: 'text', text: JSON.stringify(summary, null, 2) },
    ],
  };
}

async function execute(task, args, targets) {
  const dir = outDir();
  const run = await runTask({ task, targets, plannerTiers: await plannerTiers(args), outDir: dir });
  await writeFile(path.join(dir, 'report.md'), renderMarkdown(run));
  return toToolResult(run, dir);
}

const guard = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

export function createServer() {
  const server = new McpServer({ name: 'shijing-agent', version: VERSION });
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool('compare_pages', {
    title: 'Compare two versions of a page on one task',
    description: [
      'An agent performs the same user task on a baseline and a candidate version of a web page, each in a fresh browser,',
      'and reports clicks, the path taken and whether the output (downloaded file or page text) matches.',
      'Success is decided by independent checks, not by the agent. At least one of download_name, expected_file or success_text is required.',
      'Risky controls (buy, delete, sign in, publish...) are never pressed and non-GET requests are blocked.',
      'Only use on sites the user owns or may test. Local paths are resolved from the server working directory.',
    ].join(' '),
    inputSchema: {
      goal: z.string().min(3).describe('What a user wants to do, in their words, e.g. "Export the task list as a CSV file".'),
      baseline: z.string().describe('URL or local HTML path of the current version.'),
      candidate: z.string().describe('URL or local HTML path of the new version.'),
      download_name: z.string().optional().describe('Glob for the expected download, e.g. "*.csv".'),
      expected_file: z.string().optional().describe('Path to a file the download must match byte for byte.'),
      success_text: z.string().optional().describe('Text the page must show when the task is done.'),
      max_steps: z.number().int().min(1).max(50).optional(),
      ...plannerArgs,
    },
    annotations,
  }, guard(async (args) => {
    const success = {};
    if (args.download_name || args.expected_file) success.download = { name: args.download_name ?? '*', equals: args.expected_file };
    if (args.success_text) success.text = args.success_text;
    const task = normalizeTask({
      name: args.goal,
      goal: args.goal,
      targets: { baseline: args.baseline, candidate: args.candidate },
      success,
      maxSteps: args.max_steps,
    }, process.cwd());
    return execute(task, args);
  }));

  server.registerTool('run_task_file', {
    title: 'Run a shijing task file',
    description: 'Run a task YAML (goal, targets, success checks; see docs/task-format.md) and return the comparison report.',
    inputSchema: {
      path: z.string().describe('Path to the task YAML, relative to the server working directory or absolute.'),
      targets: z.array(z.string()).optional().describe('Only run these targets. Default: all, in file order.'),
      ...plannerArgs,
    },
    annotations,
  }, guard(async (args) => execute(await loadTask(args.path), args, args.targets)));

  server.registerTool('run_demo', {
    title: 'Run the built-in demo',
    description: 'Runs the bundled example (a checklist page whose redesign moves Export CSV to the toolbar) to show what a report looks like. Offline, about 10 seconds.',
    inputSchema: {},
    annotations: { ...annotations, openWorldHint: false },
  }, guard(async () => execute(await loadTask(DEMO_TASK), {})));

  return server;
}

export async function startStdioServer() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`shijing-agent MCP server ${VERSION} ready on stdio\n`);
}
