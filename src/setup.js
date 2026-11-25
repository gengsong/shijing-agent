import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * `shijing setup`: connect shijing-agent to the coding agents on this machine.
 *
 * For each client it finds, it plans one or two changes (register the MCP
 * server, install the UX-check skill), shows the plan, and applies it only
 * after approval. Every config file it edits is backed up first; a file it
 * cannot parse is left alone. `--remove` undoes the same changes.
 */

export const SERVER_NAME = 'shijing';
export const SERVER = { command: 'npx', args: ['-y', 'shijing-agent', 'mcp'] };
const SKILL_NAME = 'shijing-ux-check';
const SKILL_SOURCE = new URL('../skills/shijing-ux-check/SKILL.md', import.meta.url);
const CODEX_HEADER = `[mcp_servers.${SERVER_NAME}]`;

export function defaultEnv() {
  return {
    home: os.homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
    which: (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).status === 0,
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
      return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
    },
  };
}

function claudeDesktopConfig(env) {
  if (env.platform === 'darwin') return path.join(env.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (env.platform === 'win32') return env.appData ? path.join(env.appData, 'Claude', 'claude_desktop_config.json') : null;
  return path.join(env.home, '.config', 'Claude', 'claude_desktop_config.json');
}

/** JSON configs with an `mcpServers` map (Claude Desktop, Cursor). */
function jsonClient(name, file, presentIf) {
  return {
    name,
    detect: () => file && (existsSync(file) || existsSync(path.dirname(file)) || presentIf?.()),
    async plan(remove) {
      let config = {};
      if (existsSync(file)) {
        try {
          config = JSON.parse((await readFile(file, 'utf8')) || '{}');
        } catch {
          return [{ client: name, kind: 'mcp', status: 'skip', detail: `${file} is not valid JSON; edit it by hand` }];
        }
      }
      const has = Boolean(config.mcpServers?.[SERVER_NAME]);
      if (remove) {
        return [{ client: name, kind: 'mcp', status: has ? 'remove' : 'absent', detail: file,
          apply: async () => {
            delete config.mcpServers[SERVER_NAME];
            await backupAndWrite(file, JSON.stringify(config, null, 2) + '\n');
          } }];
      }
      return [{ client: name, kind: 'mcp', status: has ? 'present' : 'add', detail: file,
        apply: async () => {
          config.mcpServers = { ...config.mcpServers, [SERVER_NAME]: { ...SERVER } };
          await backupAndWrite(file, JSON.stringify(config, null, 2) + '\n');
        } }];
    },
  };
}

function claudeCode(env) {
  const skillDir = path.join(env.home, '.claude', 'skills', SKILL_NAME);
  const addArgs = ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', SERVER.command, ...SERVER.args];
  return {
    name: 'Claude Code',
    detect: () => env.which('claude') || existsSync(path.join(env.home, '.claude')),
    async plan(remove) {
      const steps = [];
      if (!env.which('claude')) {
        steps.push({ client: 'Claude Code', kind: 'mcp', status: 'skip', detail: '`claude` is not on PATH; run: claude ' + addArgs.join(' ') });
      } else {
        const has = env.run('claude', ['mcp', 'get', SERVER_NAME]).code === 0;
        steps.push(remove
          ? { client: 'Claude Code', kind: 'mcp', status: has ? 'remove' : 'absent', detail: `claude mcp remove -s user ${SERVER_NAME}`,
            apply: async () => check(env.run('claude', ['mcp', 'remove', '-s', 'user', SERVER_NAME])) }
          : { client: 'Claude Code', kind: 'mcp', status: has ? 'present' : 'add', detail: `claude ${addArgs.join(' ')}`,
            apply: async () => check(env.run('claude', addArgs)) });
      }
      const skillFile = path.join(skillDir, 'SKILL.md');
      const hasSkill = existsSync(skillFile);
      steps.push(remove
        ? { client: 'Claude Code', kind: 'skill', status: hasSkill ? 'remove' : 'absent', detail: skillDir,
          apply: async () => rm(skillDir, { recursive: true, force: true }) }
        : { client: 'Claude Code', kind: 'skill', status: hasSkill ? 'update' : 'add', detail: skillFile,
          apply: async () => {
            await mkdir(skillDir, { recursive: true });
            await writeFile(skillFile, await readFile(SKILL_SOURCE, 'utf8'));
          } });
      return steps;
    },
  };
}

function codex(env) {
  const file = path.join(env.home, '.codex', 'config.toml');
  const block = `\n${CODEX_HEADER}\ncommand = "${SERVER.command}"\nargs = [${SERVER.args.map((a) => `"${a}"`).join(', ')}]\n`;
  return {
    name: 'Codex',
    detect: () => env.which('codex') || existsSync(path.dirname(file)),
    async plan(remove) {
      const text = existsSync(file) ? await readFile(file, 'utf8') : '';
      const has = text.includes(CODEX_HEADER);
      if (remove) {
        return [{ client: 'Codex', kind: 'mcp', status: has ? 'remove' : 'absent', detail: file,
          apply: async () => backupAndWrite(file, removeTomlTable(text, CODEX_HEADER)) }];
      }
      return [{ client: 'Codex', kind: 'mcp', status: has ? 'present' : 'add', detail: file,
        apply: async () => backupAndWrite(file, text.replace(/\n*$/, '\n') + block) }];
    },
  };
}

/** Remove one `[table]` and its keys, up to the next table header. */
export function removeTomlTable(text, header) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === header) { skipping = true; continue; }
    if (skipping && /^\s*\[/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function check({ code, output }) {
  if (code !== 0) throw new Error(output || 'command failed');
}

async function backupAndWrite(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await copyFile(file, `${file}.shijing-backup-${stamp}`);
  }
  await writeFile(file, contents);
}

export function clients(env) {
  return [
    claudeCode(env),
    jsonClient('Claude Desktop', claudeDesktopConfig(env)),
    jsonClient('Cursor', path.join(env.home, '.cursor', 'mcp.json'), () => env.which('cursor')),
    codex(env),
  ];
}

/** Build the plan for every detected client (or the named ones). */
export async function planSetup({ env = defaultEnv(), only, remove = false } = {}) {
  const all = clients(env);
  const wanted = only?.length ? all.filter((c) => only.some((o) => c.name.toLowerCase().replace(/\s/g, '-') === o.toLowerCase())) : all;
  const steps = [];
  const missing = [];
  for (const c of wanted) {
    if (!only?.length && !c.detect()) { missing.push(c.name); continue; }
    steps.push(...(await c.plan(remove)));
  }
  return { steps, missing };
}

const LABEL = { add: 'add', update: 'update', remove: 'remove', present: 'already set up', absent: 'not installed', skip: 'skip' };

export function formatPlan({ steps, missing }) {
  const lines = steps.map((s) => `  ${s.client.padEnd(15)} ${s.kind.padEnd(6)} ${LABEL[s.status].padEnd(15)} ${s.detail}`);
  if (missing.length) lines.push(`  Not found: ${missing.join(', ')}`);
  return lines.join('\n');
}

/** Apply the steps that change something. Returns per-step results. */
export async function applyPlan({ steps }) {
  const results = [];
  for (const s of steps) {
    if (!['add', 'update', 'remove'].includes(s.status)) continue;
    try {
      await s.apply();
      results.push({ ...s, ok: true });
    } catch (e) {
      results.push({ ...s, ok: false, error: e.message });
    }
  }
  return results;
}
