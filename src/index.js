export { loadTask, normalizeTask, TaskError } from './task.js';
export { runTask, runTarget, launchBrowser } from './run.js';
export { renderMarkdown, compare } from './report.js';
export { VERSION } from './run.js';
export { createRulesPlanner } from './planners/rules.js';
export { checkDownload, checkText } from './checks.js';

/** Lazily load the Claude planner so the offline path never needs an API key. */
export async function createClaudePlanner(options) {
  const mod = await import('./planners/claude.js');
  return mod.createClaudePlanner(options);
}

/** Sonnet first, Opus if Sonnet does not finish the task. */
export async function claudeTiers(options) {
  const mod = await import('./planners/claude.js');
  return mod.claudeTiers(options);
}
