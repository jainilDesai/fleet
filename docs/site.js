// Copy buttons and the docs table of contents.
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
