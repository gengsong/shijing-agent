// `shijing setup`, run against a temporary home directory with a fake `claude` CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planSetup, applyPlan, removeTomlTable, formatPlan } from '../src/setup.js';

async function fakeEnv({ claude = true } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'shijing-home-'));
  const calls = [];
  const registered = new Set();
  return {
    home,
    calls,
    env: {
      home,
      platform: 'darwin',
      which: (cmd) => (cmd === 'claude' ? claude : false),
      run: (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        if (args[1] === 'get') return { code: registered.has(args[2]) ? 0 : 1, output: '' };
        if (args[1] === 'add') { registered.add(args[4]); return { code: 0, output: '' }; }
        if (args[1] === 'remove') { registered.delete(args[4]); return { code: 0, output: '' }; }
        return { code: 1, output: 'unexpected' };
      },
    },
  };
}

const desktopConfig = (home) => path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

test('detects installed clients only, keeps other servers, backs up, and is idempotent', async () => {
  const { home, env, calls } = await fakeEnv();
  await mkdir(path.dirname(desktopConfig(home)), { recursive: true });
  await writeFile(desktopConfig(home), JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));

  const plan = await planSetup({ env });
  assert.deepEqual(plan.steps.map((s) => [s.client, s.kind, s.status]), [
    ['Claude Code', 'mcp', 'add'],
    ['Claude Code', 'skill', 'add'],
    ['Claude Desktop', 'mcp', 'add'],
  ]);
  assert.deepEqual(plan.missing, ['Cursor', 'Codex']);
  assert.match(formatPlan(plan), /Not found: Cursor, Codex/);

  const results = await applyPlan(plan);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.ok(calls.includes('claude mcp add -s user shijing -- npx -y shijing-agent mcp'));
  assert.match(await readFile(path.join(home, '.claude/skills/shijing-ux-check/SKILL.md'), 'utf8'), /^---\nname: shijing-ux-check/);

  const config = JSON.parse(await readFile(desktopConfig(home), 'utf8'));
  assert.deepEqual(config.mcpServers.shijing, { command: 'npx', args: ['-y', 'shijing-agent', 'mcp'] });
  assert.deepEqual(config.mcpServers.other, { command: 'x' });
  assert.equal(config.theme, 'dark');
  const backups = (await readdir(path.dirname(desktopConfig(home)))).filter((f) => f.includes('shijing-backup'));
  assert.equal(backups.length, 1);

  const again = await planSetup({ env });
  assert.deepEqual(again.steps.map((s) => s.status), ['present', 'update', 'present']);
});

test('--remove undoes everything it added', async () => {
  const { home, env } = await fakeEnv();
  await mkdir(path.dirname(desktopConfig(home)), { recursive: true });
  await applyPlan(await planSetup({ env }));

  const removal = await planSetup({ env, remove: true });
  assert.deepEqual(removal.steps.map((s) => s.status), ['remove', 'remove', 'remove']);
  await applyPlan(removal);

  assert.ok(!existsSync(path.join(home, '.claude/skills/shijing-ux-check')));
  const config = JSON.parse(await readFile(desktopConfig(home), 'utf8'));
  assert.equal(config.mcpServers.shijing, undefined);
  assert.deepEqual((await planSetup({ env, remove: true })).steps.map((s) => s.status), ['absent', 'absent', 'absent']);
});

test('never overwrites a config file it cannot parse', async () => {
  const { home, env } = await fakeEnv({ claude: false });
  const cursor = path.join(home, '.cursor', 'mcp.json');
  await mkdir(path.dirname(cursor), { recursive: true });
  await writeFile(cursor, '{ "mcpServers": { broken');

  const plan = await planSetup({ env, only: ['cursor'] });
  assert.equal(plan.steps[0].status, 'skip');
  assert.match(plan.steps[0].detail, /not valid JSON/);
  await applyPlan(plan);
  assert.equal(await readFile(cursor, 'utf8'), '{ "mcpServers": { broken');
});

test('Claude Code without the CLI on PATH: skill only, with the manual command', async () => {
  const { home, env } = await fakeEnv({ claude: false });
  await mkdir(path.join(home, '.claude'), { recursive: true });
  const plan = await planSetup({ env, only: ['claude-code'] });
  assert.equal(plan.steps[0].status, 'skip');
  assert.match(plan.steps[0].detail, /claude mcp add -s user shijing -- npx -y shijing-agent mcp/);
  assert.equal(plan.steps[1].status, 'add');
});

test('Codex: appends a TOML table and removes only that table', async () => {
  const { home, env } = await fakeEnv({ claude: false });
  const file = path.join(home, '.codex', 'config.toml');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n');

  await applyPlan(await planSetup({ env, only: ['codex'] }));
  const added = await readFile(file, 'utf8');
  assert.match(added, /\[mcp_servers\.shijing\]\ncommand = "npx"\nargs = \["-y", "shijing-agent", "mcp"\]/);
  assert.match(added, /\[mcp_servers\.other\]/);

  await applyPlan(await planSetup({ env, only: ['codex'], remove: true }));
  const removed = await readFile(file, 'utf8');
  assert.ok(!removed.includes('shijing'));
  assert.match(removed, /model = "x"[\s\S]*\[mcp_servers\.other\]\ncommand = "y"/);
});

test('removeTomlTable stops at the next table', () => {
  const text = '[a]\nx = 1\n[mcp_servers.shijing]\ncommand = "npx"\n[b]\ny = 2\n';
  assert.equal(removeTomlTable(text, '[mcp_servers.shijing]'), '[a]\nx = 1\n[b]\ny = 2\n');
});
