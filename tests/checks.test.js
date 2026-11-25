import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkDownload, globToRegExp } from '../src/checks.js';
import { normalizeTask, TaskError } from '../src/task.js';
import { compare } from '../src/report.js';

test('glob matching', () => {
  assert.ok(globToRegExp('*.csv').test('Checklist.CSV'));
  assert.ok(!globToRegExp('*.csv').test('checklist.json'));
});

test('download check compares bytes and explains the first difference', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'shijing-'));
  const expected = path.join(dir, 'expected.csv');
  await writeFile(expected, 'a,b\r\n1,2\r\n');

  const ok = await checkDownload({ name: '*.csv', equals: expected }, { name: 'x.csv', bytes: Buffer.from('a,b\r\n1,2\r\n') });
  assert.equal(ok.pass, true);

  const extra = await checkDownload({ name: '*.csv', equals: expected }, { name: 'x.csv', bytes: Buffer.from('a,b\r\n1,2\r\n3,4\r\n') });
  assert.equal(extra.pass, false);
  assert.match(extra.detail, /line 3 expected "<end of file>", got "3,4"/);

  const wrongType = await checkDownload({ name: '*.csv', equals: expected }, { name: 'x.json', bytes: Buffer.from('{}') });
  assert.equal(wrongType.pass, false);
});

test('task validation', () => {
  assert.throws(() => normalizeTask({ goal: 'x', targets: {} , success: { text: 'y' } }, '/'), TaskError);
  assert.throws(() => normalizeTask({ goal: 'x', targets: { a: 'https://e.com' }, success: {} }, '/'), TaskError);
  const t = normalizeTask({ goal: 'x', targets: { a: 'https://e.com', b: './v2.html' }, success: { text: 'Done' } }, '/base');
  assert.equal(t.targets.a.kind, 'url');
  assert.equal(t.targets.b.file, path.resolve('/base', 'v2.html'));
  assert.equal(t.maxSteps, 12);
});

test('verdict wording', () => {
  const r = (target, status, clicks, sha) => ({ target, status, clicks, output: sha ? { sha256: sha } : null });
  assert.match(compare([r('a', 'passed', 5, 'x'), r('b', 'passed', 1, 'x')]), /1 click instead of 5 \(-4\) with identical output/);
  assert.match(compare([r('a', 'passed', 2, 'x'), r('b', 'failed', 3)]), /regression/);
  assert.match(compare([r('a', 'passed', 1, 'x'), r('b', 'passed', 3, 'y')]), /2 more clicks.*output differs/);
});
