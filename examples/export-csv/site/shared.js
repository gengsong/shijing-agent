// Shared data and export logic: both versions produce the same CSV bytes.
export const tasks = [
  { task: 'Review the new homepage', status: 'To do' },
  { task: 'Check the export result', status: 'In progress' },
  { task: 'Collect user feedback', status: 'Done' },
];

export function toCsv(rows) {
  const esc = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return ['Task,Status', ...rows.map((r) => `${esc(r.task)},${esc(r.status)}`)].join('\r\n') + '\r\n';
}

export function toJson(rows) {
  return JSON.stringify(rows, null, 2) + '\n';
}

export function download(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderTable(tbody, rows) {
  tbody.replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    for (const v of [r.task, r.status]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    return tr;
  }));
}

export function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
}
