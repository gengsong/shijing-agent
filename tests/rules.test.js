import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRulesPlanner, tokens } from '../src/planners/rules.js';

const success = { download: { name: '*.csv', equals: null } };
const goal = 'Export the task list as a CSV file';
const view = (labels) => ({
  url: 'http://x/', title: '', headings: [],
  items: labels.map((l, id) => ({ id, label: typeof l === 'string' ? l : l.label, kind: 'button', href: '', expandable: !!l.expandable })),
});
const pick = async (planner, labels) => {
  const v = view(labels);
  const d = await planner.next({ goal, success, view: v, history: [] });
  return d.action === 'click' ? v.items[d.elementId].label : d.action;
};

test('tokens normalises synonyms and plurals', () => {
  assert.deepEqual(tokens('Download CSV'), ['export', 'csv']);
  assert.deepEqual(tokens('More actions'), ['more', 'action']);
  assert.deepEqual(tokens('Export tasks'), ['export', 'task']);
});

test('prefers a direct export control', async () => {
  const p = createRulesPlanner();
  assert.equal(await pick(p, ['Add task', 'Filter', 'Export CSV', { label: 'More', expandable: true }]), 'Export CSV');
});

test('does not press a control whose verb the goal does not ask for', async () => {
  const p = createRulesPlanner();
  // "Add task" shares the word "task" with the goal but would change the data.
  assert.equal(await pick(p, ['Add task', 'Filter', { label: 'More actions', expandable: true }]), 'More actions');
});

test('walks nested menus to the export', async () => {
  const p = createRulesPlanner();
  const base = ['Add task', 'Filter', { label: 'More actions', expandable: true }];
  assert.equal(await pick(p, base), 'More actions');
  assert.equal(await pick(p, [...base, 'Print', { label: 'Data management', expandable: true }, 'Settings']), 'Data management');
  assert.equal(await pick(p, [...base, 'Print', { label: 'Data management', expandable: true }, 'Settings', 'Import list', 'Export list']), 'Export list');
  assert.equal(await pick(p, ['Choose CSV', 'Choose JSON', 'Cancel']), 'Choose CSV');
  assert.equal(await pick(p, ['Choose CSV', 'Choose JSON', 'Cancel', 'Download CSV']), 'Download CSV');
});

test('gives up when nothing relates to the goal', async () => {
  const p = createRulesPlanner();
  assert.equal(await pick(p, ['Add task', 'Settings']), 'give_up');
});
