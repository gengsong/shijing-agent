import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export class TaskError extends Error {}

/**
 * Load and validate a task file.
 *
 * A task says what a user is trying to do, where to try it, and how an
 * independent check decides whether it worked. See docs/task-format.md.
 */
export async function loadTask(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = YAML.parse(await readFile(abs, 'utf8'));
  } catch (e) {
    throw new TaskError(`Cannot read task file ${file}: ${e.message}`);
  }
  return normalizeTask(raw, path.dirname(abs));
}

export function normalizeTask(raw, baseDir) {
  if (!raw || typeof raw !== 'object') throw new TaskError('Task file is empty.');
  const need = (cond, msg) => { if (!cond) throw new TaskError(msg); };

  need(typeof raw.goal === 'string' && raw.goal.trim(), '`goal` is required, e.g. "Export the task list as CSV".');
  need(raw.targets && typeof raw.targets === 'object' && Object.keys(raw.targets).length, '`targets` needs at least one entry, e.g. baseline: ./v1/index.html');
  need(raw.success && typeof raw.success === 'object', '`success` is required: describe how to check the result (download and/or text).');
  need(raw.success.download || raw.success.text, '`success` needs `download` or `text`.');

  const targets = {};
  for (const [name, value] of Object.entries(raw.targets)) {
    need(/^[a-z0-9_-]+$/i.test(name), `Target name "${name}" may only use letters, digits, - and _.`);
    need(typeof value === 'string' && value, `Target "${name}" must be a URL or a path to a local HTML file.`);
    targets[name] = /^https?:\/\//i.test(value)
      ? { kind: 'url', url: value }
      : { kind: 'file', file: path.resolve(baseDir, value) };
  }

  const success = {};
  if (raw.success.download) {
    const d = raw.success.download;
    success.download = {
      name: typeof d.name === 'string' ? d.name : '*',
      equals: d.equals ? path.resolve(baseDir, d.equals) : null,
    };
  }
  if (raw.success.text) {
    need(typeof raw.success.text === 'string', '`success.text` must be a string.');
    success.text = raw.success.text;
  }

  const maxSteps = raw.maxSteps ?? 12;
  need(Number.isInteger(maxSteps) && maxSteps > 0 && maxSteps <= 50, '`maxSteps` must be an integer between 1 and 50.');

  return {
    name: typeof raw.name === 'string' ? raw.name : raw.goal,
    goal: raw.goal.trim(),
    targets,
    success,
    maxSteps,
    viewport: raw.viewport ?? { width: 1280, height: 800 },
    allowWrites: raw.allowWrites === true,
    baseDir,
  };
}

/** A short human description of the success check, given to planners. */
export function describeSuccess(success) {
  const parts = [];
  if (success.download) parts.push(`a file matching "${success.download.name}" is downloaded`);
  if (success.text) parts.push(`the page shows the text "${success.text}"`);
  return parts.join(' and ');
}
