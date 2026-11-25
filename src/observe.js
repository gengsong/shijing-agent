/**
 * Read what a user could act on right now: visible, enabled controls with
 * their accessible labels, plus visible headings for context.
 *
 * Each control gets a fresh `data-shijing-id` so the chosen action can be
 * executed against exactly the element the planner saw.
 */
export async function observe(page) {
  return page.evaluate(() => {
    const SELECTOR = [
      'a[href]', 'button', '[role=button]', '[role=menuitem]', '[role=tab]', 'summary',
      'input[type=search]', 'input[type=text]', 'input:not([type])',
    ].join(',');
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };

    document.querySelectorAll('[data-shijing-id]').forEach((el) => el.removeAttribute('data-shijing-id'));
    const items = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const isInput = el.matches('input');
      const label = clean(
        el.getAttribute('aria-label') ||
        (isInput ? el.labels?.[0]?.innerText || el.placeholder || el.name : el.innerText) ||
        el.title ||
        el.querySelector('img')?.alt,
      ).slice(0, 120);
      if (!label) continue;
      const id = items.length;
      el.setAttribute('data-shijing-id', String(id));
      items.push({
        id,
        label,
        kind: isInput ? 'input' : el.matches('a') ? 'link' : 'button',
        href: el.matches('a') ? el.href : '',
        expandable: el.matches('summary') || el.hasAttribute('aria-haspopup') || el.getAttribute('aria-expanded') === 'false',
      });
      if (items.length >= 150) break;
    }

    const headings = [...document.querySelectorAll('h1,h2,h3,[role=dialog] [role=heading],[role=status]')]
      .filter(visible)
      .map((el) => clean(el.innerText).slice(0, 160))
      .filter(Boolean)
      .slice(0, 30);

    return { url: location.href, title: document.title, items, headings };
  });
}
