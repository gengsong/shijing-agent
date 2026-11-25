// The Claude planner, tested offline with a stub client: request shape and response handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudePlanner } from '../src/planners/claude.js';

const view = { url: 'http://x/', title: 'Checklist', headings: ['Release checklist'], items: [
  { id: 0, label: 'Add task', kind: 'button', href: '', expandable: false },
  { id: 1, label: 'Export CSV', kind: 'button', href: '', expandable: false },
] };

function stub(response) {
  const calls = [];
  return { calls, beta: { messages: { create: async (req) => { calls.push(req); return response; } } } };
}

const usage = { input_tokens: 900, output_tokens: 60 };

test('sends goal and controls, returns the chosen click', async () => {
  const client = stub({ stop_reason: 'tool_use', usage, content: [
    { type: 'tool_use', name: 'choose_action', input: { action: 'click', element_id: 1, text: '', reason: 'Exports directly.' } },
  ] });
  const planner = createClaudePlanner({ client });
  const d = await planner.next({ goal: 'Export as CSV', successText: 'a CSV is downloaded', view, history: [] });

  assert.deepEqual(d, { action: 'click', elementId: 1, text: '', reason: 'Exports directly.' });
  const req = client.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.tool_choice.type, 'auto');
  assert.equal(req.tools[0].strict, true);
  assert.match(req.messages[0].content, /Export CSV/);
  assert.equal(planner.usage.requests, 1);
  assert.equal(planner.usage.input_tokens, 900);
});

test('a refusal or missing tool call becomes give_up', async () => {
  const refused = createClaudePlanner({ client: stub({ stop_reason: 'refusal', usage, content: [] }) });
  assert.equal((await refused.next({ goal: 'x', successText: 'y', view, history: [] })).action, 'give_up');

  const chatty = createClaudePlanner({ client: stub({ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Hmm' }] }) });
  assert.equal((await chatty.next({ goal: 'x', successText: 'y', view, history: [] })).action, 'give_up');
});

test('default routing is Sonnet first, then Opus', async () => {
  const { claudeTiers } = await import('../src/planners/claude.js');
  const client = stub({ stop_reason: 'end_turn', usage, content: [] });
  const names = claudeTiers({ client }).map((make) => make().name);
  assert.deepEqual(names, ['claude:claude-sonnet-5-5', 'claude:claude-opus-5-5']);
});

test('report shows the escalation chain and the summed cost', async () => {
  const { plannerCell } = await import('../src/report.js');
  const cell = plannerCell({
    planner: 'claude:claude-opus-5-5',
    attempts: [
      { planner: 'claude:claude-sonnet-5-5', status: 'failed', usage: { requests: 4, input_tokens: 1_000_000, output_tokens: 0 } },
      { planner: 'claude:claude-opus-5-5', status: 'passed', usage: { requests: 2, input_tokens: 1_000_000, output_tokens: 0 } },
    ],
  });
  assert.equal(cell, 'sonnet-5-5 (failed) → opus-5-5 (passed) · 6 calls · ~$6.0000');
});
