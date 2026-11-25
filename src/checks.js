import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Independent success checks. They look only at real outputs (the downloaded
 * bytes, the rendered page), never at what the planner claims.
 */

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * @returns {Promise<{pass: boolean, detail: string}>}
 */
export async function checkDownload(spec, file) {
  if (!globToRegExp(spec.name).test(file.name)) {
    return { pass: false, detail: `Downloaded "${file.name}", expected a file matching "${spec.name}".` };
  }
  if (!spec.equals) return { pass: true, detail: `Downloaded "${file.name}" (${file.bytes.length} bytes).` };

  const expected = await readFile(spec.equals);
  if (Buffer.compare(expected, file.bytes) === 0) {
    return { pass: true, detail: `"${file.name}" is byte-identical to ${path.basename(spec.equals)}.` };
  }
  return { pass: false, detail: `"${file.name}" differs from ${path.basename(spec.equals)}: ${describeDiff(expected, file.bytes)}` };
}

function describeDiff(expected, actual) {
  const lines = (buf) => buf.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/);
  const a = lines(expected);
  const b = lines(actual);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1} expected ${JSON.stringify(a[i] ?? '<end of file>')}, got ${JSON.stringify(b[i] ?? '<end of file>')}.`;
    }
  }
  return `${expected.length} vs ${actual.length} bytes.`;
}

export async function checkText(spec, page) {
  const body = await page.locator('body').innerText().catch(() => '');
  return body.includes(spec)
    ? { pass: true, detail: `Page shows "${spec}".` }
    : { pass: false, detail: `Page does not show "${spec}".` };
}
