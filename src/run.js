import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { observe } from './observe.js';
import { allowedItems } from './policy.js';
import { checkDownload, checkText, sha256 } from './checks.js';
import { describeSuccess } from './task.js';
import { serveDirectory } from './serve.js';

export async function launchBrowser({ headed = false, channel } = {}) {
  const { chromium } = await import('playwright');
  const opts = { headless: !headed };
  if (channel) return chromium.launch({ ...opts, channel });
  try {
    return await chromium.launch(opts);
  } catch (e) {
    // No bundled Chromium yet: fall back to the user's installed Chrome.
    if (/Executable doesn't exist|playwright install/i.test(e.message)) return chromium.launch({ ...opts, channel: 'chrome' });
    throw e;
  }
}

/**
 * Run one task against one target in a fresh browser context.
 *
 * @returns {Promise<object>} result with status, clicks, steps and output.
 */
export async function runTarget({ task, targetName, browser, planner, outDir, onStep = () => {} }) {
  const target = task.targets[targetName];
  let server = null;
  let url = target.url;
  if (target.kind === 'file') {
    server = await serveDirectory(task.baseDir);
    url = server.urlFor(target.file);
  }

  const origin = new URL(url).origin;
  const context = await browser.newContext({ viewport: task.viewport, acceptDownloads: true, serviceWorkers: 'block' });
  let page;
  await context.route('**/*', (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (!task.allowWrites && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.abort('blockedbyclient');
    if (req.isNavigationRequest() && page && req.frame() === page.mainFrame() && u.origin !== origin) return route.abort('blockedbyclient');
    return route.continue();
  });

  const started = Date.now();
  const steps = [];
  const result = { target: targetName, url: target.kind === 'file' ? path.relative(process.cwd(), target.file) : url, status: 'failed', reason: '', clicks: 0, steps, output: null, checks: [] };

  try {
    page = await context.newPage();
    context.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.setDefaultTimeout(8000);

    let pendingDownload = null;
    page.on('download', (dl) => { pendingDownload = dl; });

    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!res || !res.ok()) throw new Error(`Could not open ${url}${res ? ` (HTTP ${res.status()})` : ''}`);

    const successText = describeSuccess(task.success);
    for (let step = 1; step <= task.maxSteps; step++) {
      const view = await observe(page);
      view.items = allowedItems(view.items);
      const decision = await planner.next({ goal: task.goal, success: task.success, successText, view, history: steps });

      if (decision.action === 'give_up') {
        result.reason = `Agent stopped: ${decision.reason}`;
        break;
      }
      const item = view.items.find((i) => i.id === decision.elementId);
      if (!item) {
        result.reason = `Agent chose a control that is not on the page (id ${decision.elementId}).`;
        break;
      }

      const el = page.locator(`[data-shijing-id="${item.id}"]`);
      pendingDownload = null;
      if (decision.action === 'type') {
        await el.fill(String(decision.text ?? '').slice(0, 200));
        await el.press('Enter');
      } else {
        await el.click();
      }
      result.clicks += 1;
      const record = { step, action: decision.action, label: item.label, text: decision.action === 'type' ? decision.text : undefined, reason: decision.reason, url: view.url };
      steps.push(record);
      onStep(record);

      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);

      if (task.success.download && pendingDownload) {
        const dl = pendingDownload;
        const file = path.join(outDir, `${targetName}-${dl.suggestedFilename()}`);
        await dl.saveAs(file);
        const bytes = await readFile(file);
        result.output = { file: path.relative(process.cwd(), file), name: dl.suggestedFilename(), bytes: bytes.length, sha256: sha256(bytes) };
        const check = await checkDownload(task.success.download, { name: dl.suggestedFilename(), bytes });
        result.checks.push({ kind: 'download', ...check });
        if (!check.pass) { result.reason = check.detail; break; }
        if (!task.success.text) { result.status = 'passed'; break; }
      }
      if (task.success.text && (!task.success.download || result.output)) {
        const check = await checkText(task.success.text, page);
        if (check.pass) {
          result.checks.push({ kind: 'text', ...check });
          result.status = 'passed';
          break;
        }
      }
    }
    if (result.status !== 'passed' && !result.reason) result.reason = `Not done after ${task.maxSteps} steps.`;
    if (result.status === 'passed') result.reason = result.checks.map((c) => c.detail).join(' ');

    await page.screenshot({ path: path.join(outDir, `${targetName}-final.png`) }).catch(() => {});
  } catch (e) {
    result.status = 'error';
    result.reason = e.message.split('\n')[0];
  } finally {
    await context.close().catch(() => {});
    await server?.close();
  }
  result.seconds = Math.round((Date.now() - started) / 100) / 10;
  return result;
}

/** Run a task on every target (or the named ones) and write result.json. */
export async function runTask({ task, targets, plannerFactory, outDir, headed, channel, onStep }) {
  await mkdir(outDir, { recursive: true });
  const browser = await launchBrowser({ headed, channel });
  const results = [];
  try {
    for (const name of targets ?? Object.keys(task.targets)) {
      if (!task.targets[name]) throw new Error(`Unknown target "${name}". Known: ${Object.keys(task.targets).join(', ')}`);
      const planner = plannerFactory();
      const r = await runTarget({ task, targetName: name, browser, planner, outDir, onStep: (s) => onStep?.(name, s) });
      r.planner = planner.name;
      if (planner.usage) r.usage = { ...planner.usage };
      results.push(r);
    }
  } finally {
    await browser.close();
  }
  const run = { tool: 'shijing-agent', version: '0.1.0', task: { name: task.name, goal: task.goal }, startedAt: new Date().toISOString(), results };
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify(run, null, 2) + '\n');
  return run;
}
