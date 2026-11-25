/**
 * Rules planner: offline, free and deterministic.
 *
 * It scores each visible control against the goal and the success check,
 * penalises controls whose verb is not part of the goal ("Add task" when the
 * goal is to export), and opens unexplored menus when nothing matches yet.
 * Good for simple read / export / navigate tasks and for CI. For anything
 * fuzzier, use the Claude planner.
 */

const SYNONYMS = {
  download: 'export', save: 'export', export: 'export',
  spreadsheet: 'csv', csv: 'csv',
  table: 'list', list: 'list',
  find: 'search', search: 'search', lookup: 'search',
};

// Verbs that change something or lead elsewhere. A control starting with one
// of these is penalised unless the goal asks for that verb.
const OTHER_VERBS = new Set([
  'add', 'create', 'new', 'edit', 'rename', 'duplicate', 'archive', 'remove', 'clear',
  'filter', 'sort', 'print', 'import', 'share', 'invite', 'settings', 'cancel', 'close', 'reset',
]);

const STOP = new Set(['a', 'an', 'the', 'as', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'my', 'all', 'with', 'from', 'into', 'file']);

function stem(t) {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !/(ss|us)$/.test(t)) return t.slice(0, -1);
  return t;
}

export function tokens(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => !STOP.has(t))
    .map((t) => SYNONYMS[t] ?? SYNONYMS[stem(t)] ?? stem(t));
}

export function createRulesPlanner() {
  const clicked = new Set();
  let previous = new Set();

  return {
    name: 'rules',
    usage: null,
    async next({ goal, success, view }) {
      const goalWeights = new Map();
      for (const t of tokens(goal)) goalWeights.set(t, 1);
      // The success check says what really matters: the output format and the act of exporting.
      if (success.download) {
        goalWeights.set('export', 2);
        const ext = (success.download.name.match(/\.([a-z0-9]+)$/i) || [])[1];
        if (ext) goalWeights.set(tokens(ext)[0], 2);
      }
      const goalTokens = new Set(goalWeights.keys());

      let best = null;
      for (const item of view.items) {
        const key = `${item.label}|${item.href}`;
        if (clicked.has(key) || item.kind === 'input') continue;
        const words = tokens(item.label);
        let score = 0;
        for (const w of new Set(words)) score += goalWeights.get(w) || 0;
        if (words.some((w) => OTHER_VERBS.has(w) && !goalTokens.has(w))) score -= 1.5;
        if (score <= 0 && item.expandable) score += 0.5; // worth opening to look inside
        if (!previous.has(key)) score += 0.25; // just appeared: probably a result of the last action
        if (!best || score > best.score) best = { item, score, key };
      }

      previous = new Set(view.items.map((i) => `${i.label}|${i.href}`));
      if (!best || best.score <= 0.25) {
        return { action: 'give_up', reason: 'No visible control relates to the goal.' };
      }
      clicked.add(best.key);
      return {
        action: 'click',
        elementId: best.item.id,
        reason: `Best match for the goal (score ${best.score.toFixed(2)})`,
      };
    },
  };
}
