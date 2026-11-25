// MCP server over stdio, driven by the official MCP client. Needs a browser (see e2e.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'bin/shijing.js'), 'mcp'],
    cwd: root,
    env: { ...process.env, SHIJING_OUT_DIR: await mkdtemp(path.join(tmpdir(), 'shijing-mcp-')), ANTHROPIC_API_KEY: '' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'shijing-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

test('lists the three tools', async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['compare_pages', 'run_demo', 'run_task_file']);
  } finally {
    await client.close();
  }
});

test('compare_pages returns the report and a JSON summary', { timeout: 120_000 }, async () => {
  const client = await connect();
  try {
    const res = await client.callTool({
      name: 'compare_pages',
      arguments: {
        goal: 'Export the task list as a CSV file',
        baseline: 'examples/export-csv/site/v1/index.html',
        candidate: 'examples/export-csv/site/v2/index.html',
        expected_file: 'examples/export-csv/expected/checklist.csv',
        download_name: '*.csv',
      },
    });
    assert.ok(!res.isError, res.content?.[0]?.text);
    assert.match(res.content[0].text, /1 click instead of 5/);
    const summary = JSON.parse(res.content[1].text);
    assert.deepEqual(summary.results.map((r) => [r.status, r.clicks]), [['passed', 5], ['passed', 1]]);
  } finally {
    await client.close();
  }
});

test('bad input and missing key come back as tool errors, not crashes', async () => {
  const client = await connect();
  try {
    const noCheck = await client.callTool({ name: 'compare_pages', arguments: { goal: 'Export it', baseline: 'a.html', candidate: 'b.html' } });
    assert.equal(noCheck.isError, true);
    assert.match(noCheck.content[0].text, /success/);

    const noKey = await client.callTool({ name: 'run_task_file', arguments: { path: 'examples/export-csv/task.yaml', planner: 'claude' } });
    assert.equal(noKey.isError, true);
    assert.match(noKey.content[0].text, /ANTHROPIC_API_KEY/);
  } finally {
    await client.close();
  }
});
