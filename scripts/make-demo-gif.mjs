// Rebuild docs/demo.gif: record the bundled demo, then put both versions side by side.
// Dev-only. Needs ffmpeg on PATH and `npx playwright install chromium ffmpeg`.
// Usage: node scripts/make-demo-gif.mjs
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = await mkdtemp(path.join(tmpdir(), 'shijing-gif-'));
const out = path.join(root, 'docs', 'demo.gif');

execFileSync('node', [path.join(root, 'bin/shijing.js'), 'demo', '--video', '--slow-mo', '250', '--out', work], { stdio: 'inherit', cwd: root });
const run = JSON.parse(await readFile(path.join(work, 'result.json'), 'utf8'));
const [before, after] = run.results;
if (before.status !== 'passed' || after.status !== 'passed') throw new Error('Demo did not pass; not making a GIF.');

// Header and footer cards rendered with the browser (no font setup needed for ffmpeg).
const W = 640;
const card = (html, h, file) => ({ html, h, file: path.join(work, file) });
const cards = [
  card(`<div class="t"><b>BEFORE</b> the agent's change</div><div class="n">${before.clicks} clicks</div>`, 64, 'h1.png'),
  card(`<div class="t"><b>AFTER</b> the agent's change</div><div class="n ok">${after.clicks} click</div>`, 64, 'h2.png'),
  card(`<div class="f">Your AI agent changed the UI. Did it get easier? &nbsp;→&nbsp; <b>same task, ${before.clicks} clicks → ${after.clicks}, identical CSV</b></div>`, 44, 'foot.png'),
];
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const c of cards) {
  const width = c.file.endsWith('foot.png') ? W * 2 : W;
  await page.setViewportSize({ width, height: c.h });
  await page.setContent(`<style>
    body{margin:0;height:${c.h}px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;box-sizing:border-box;
      background:#1d1d1f;color:#f5f5f2;font:16px system-ui,-apple-system,sans-serif}
    .n{font-weight:700;font-size:22px;color:#ff8a5c}.n.ok{color:#7ee2a8}
    .f{font-family:ui-monospace,Menlo,monospace;font-size:15px;color:#c9c9c4}.f b{color:#f5f5f2}
  </style>${c.html}`);
  await page.screenshot({ path: c.file });
}
await browser.close();

// Both clips side by side; the shorter one holds its last frame. 10 fps, shared palette.
const duration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
const videos = [path.join(root, before.video), path.join(root, after.video)];
const total = Math.max(...videos.map(duration)) + 2.5;
const filter = [
  `[0:v]fps=10,scale=${W}:-2,tpad=stop_mode=clone:stop_duration=30[a0]`,
  `[1:v]fps=10,scale=${W}:-2,tpad=stop_mode=clone:stop_duration=30[b0]`,
  `[2:v][a0]vstack[a]`, `[3:v][b0]vstack[b]`,
  `[a][b]hstack[top]`, `[top][4:v]vstack,trim=duration=${total.toFixed(1)},split[s1][s2]`,
  `[s1]palettegen=max_colors=128:stats_mode=diff[p]`, `[s2][p]paletteuse=dither=bayer:bayer_scale=4`,
].join(';');
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-i', videos[0], '-i', videos[1],
  '-loop', '1', '-i', cards[0].file, '-loop', '1', '-i', cards[1].file, '-loop', '1', '-i', cards[2].file,
  '-filter_complex', filter, '-loop', '0', out,
], { stdio: 'inherit' });
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
