// Copy buttons, the hero board's live updates, and the docs table of contents.
for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Select and copy';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1600);
  });
}

// Each row cycles through what that made-up session does next, one row at a time.
const steps = {
  checkout: ['<b>Agent</b> Write tests for the one-click path', '<b>Edit</b> src/checkout/Cart.tsx', '<b>Bash</b> npm test -- checkout'],
  'rate-limits': ['<b>Write</b> src/middleware/rateLimit.ts', '<b>Bash</b> npm run test:integration', '<b>Read</b> src/middleware/index.ts'],
  docs: ['<b>WebFetch</b> retry guidance for webhooks', '<b>Write</b> content/webhooks/retries.md', '<b>Edit</b> content/webhooks/index.md'],
};
const rows = [...document.querySelectorAll('.row[data-name]')].filter((r) => steps[r.dataset.name]);
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (rows.length && !still) {
  let turn = 0;
  setInterval(() => {
    const row = rows[turn++ % rows.length];
    const list = steps[row.dataset.name];
    const next = (Number(row.dataset.step ?? 0) + 1) % list.length;
    row.dataset.step = next;
    row.classList.remove('changed');
    void row.offsetWidth; // restart the arrive animation
    row.querySelector('.now').innerHTML = list[next];
    row.classList.add('changed');
  }, 2400);
}

// Docs: mark the section being read in the sidebar.
const links = new Map([...document.querySelectorAll('.toc a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));
if (links.size) {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of links.values()) a.classList.remove('on');
        links.get(e.target.id)?.classList.add('on');
      }
    },
    { rootMargin: '-80px 0px -70% 0px' }
  );
  for (const id of links.keys()) {
    const el = document.getElementById(id);
    if (el) seen.observe(el);
  }
}
