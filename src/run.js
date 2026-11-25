import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { observe } from './observe.js';
import { allowedItems } from './policy.js';
import { checkDownload, checkText, sha256 } from './checks.js';
import { describeSuccess } from './task.js';
import { serveDirectory } from './serve.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export async function launchBrowser({ headed = false, channel, slowMo = 0 } = {}) {
  const { chromium } = await import('playwright');
  const opts = { headless: !headed, slowMo };
  if (channel) return chromium.launch({ ...opts, channel });
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (!/Executable doesn't exist|playwright install/i.test(e.message)) throw e;
    // No bundled Chromium yet: fall back to the user's installed Chrome.
    try {
      return await chromium.launch({ ...opts, channel: 'chrome' });
    } catch {
      throw new Error('No browser found. Run `npx playwright install chromium`, or install Google Chrome.');
    }
  }
}

/** Outline the control the agent is about to use, with a step badge (visible in --video recordings). */
async function highlight(page, el, text) {
  await el.evaluate((node, label) => {
    document.getElementById('__shijing_hl')?.remove();
    const r = node.getBoundingClientRect();
    const box = document.createElement('div');
    box.id = '__shijing_hl';
    Object.assign(box.style, {
      position: 'fixed', left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px`,
      border: '3px solid #ff5a1f', borderRadius: '8px', pointerEvents: 'none', zIndex: 2147483647, boxSizing: 'border-box',
    });
    const tag = document.createElement('div');
    tag.textContent = label;
    Object.assign(tag.style, {
      position: 'absolute', left: '-3px', top: `${r.height + 10}px`, whiteSpace: 'nowrap', background: '#ff5a1f', color: '#fff',
      font: '600 13px/1.6 system-ui, sans-serif', padding: '1px 8px', borderRadius: '6px',
    });
    box.append(tag);
    document.body.append(box);
  }, text).catch(() => {});
}

/**
 * Run one task against one target in a fresh browser context.
 *
 * @returns {Promise<object>} result with status, clicks, steps and output.
 */
export async function runTarget({ task, targetName, browser, planner, outDir, onStep = () => {}, video = false }) {
  const target = task.targets[targetName];
  let server = null;
  let url = target.url;
  if (target.kind === 'file') {
    server = await serveDirectory(task.baseDir);
    url = server.urlFor(target.file);
  }

  const origin = new URL(url).origin;
  const context = await browser.newContext({
    viewport: task.viewport, acceptDownloads: true, serviceWorkers: 'block',
    ...(video ? { recordVideo: { dir: outDir, size: task.viewport } } : {}),
  });
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
      if (video) {
        await highlight(page, el, `Agent · step ${step}: ${item.label}`);
        await page.waitForTimeout(700);
      }
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

    if (video) {
      await page.evaluate(() => document.getElementById('__shijing_hl')?.remove()).catch(() => {});
      await page.waitForTimeout(1500); // let the result settle on screen
    }
    await page.screenshot({ path: path.join(outDir, `${targetName}-final.png`) }).catch(() => {});
  } catch (e) {
    result.status = 'error';
    result.reason = e.message.split('\n')[0];
  } finally {
    const recording = video ? page?.video() : null;
    await context.close().catch(() => {});
    if (recording) {
      const file = path.join(outDir, `${targetName}.webm`);
      await recording.saveAs(file).catch(() => {});
      await recording.delete().catch(() => {});
      result.video = path.relative(process.cwd(), file);
    }
    await server?.close();
  }
  result.seconds = Math.round((Date.now() - started) / 100) / 10;
  return result;
}

/** Run a task on every target (or the named ones) and write result.json. */
/**
 * Run a task on every target (or the named ones) and write result.json.
 *
 * `plannerTiers` is a list of planner factories, cheapest first. A target that
 * fails with one tier is re-run from scratch (fresh browser context) with the
 * next one. Errors such as an unreachable page are not retried.
 */
export async function runTask({ task, targets, plannerFactory, plannerTiers, outDir, headed, channel, onStep, onEscalate, video = false, slowMo = 0 }) {
  const tiers = plannerTiers ?? [plannerFactory];
  await mkdir(outDir, { recursive: true });
  const browser = await launchBrowser({ headed, channel, slowMo });
  const results = [];
  try {
    for (const name of targets ?? Object.keys(task.targets)) {
      if (!task.targets[name]) throw new Error(`Unknown target "${name}". Known: ${Object.keys(task.targets).join(', ')}`);
      const attempts = [];
      let r;
      for (let i = 0; i < tiers.length; i++) {
        const planner = tiers[i]();
        r = await runTarget({ task, targetName: name, browser, planner, outDir, video, onStep: (st) => onStep?.(name, st) });
        r.planner = planner.name;
        if (planner.usage) r.usage = { ...planner.usage };
        attempts.push({ planner: r.planner, status: r.status, clicks: r.clicks, reason: r.reason, ...(r.usage ? { usage: r.usage } : {}) });
        if (r.status !== 'failed' || i === tiers.length - 1) break;
        onEscalate?.(name, r.planner, r.reason);
      }
      if (attempts.length > 1) r.attempts = attempts;
      results.push(r);
    }
  } finally {
    await browser.close();
  }
  const run = { tool: 'shijing-agent', version: VERSION, task: { name: task.name, goal: task.goal }, startedAt: new Date().toISOString(), results };
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify(run, null, 2) + '\n');
  return run;
}
