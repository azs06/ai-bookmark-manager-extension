const $ = (id) => document.getElementById(id);

// Chrome's bookmark tree has synthetic top-level folders whose names carry no
// user-intent meaning, so we don't include them as tags.
const SYNTHETIC_ROOTS = new Set([
  'Bookmarks bar', 'Bookmarks Bar',
  'Other bookmarks', 'Other Bookmarks',
  'Mobile bookmarks', 'Mobile Bookmarks',
]);

(async () => {
  const cfg = await chrome.storage.local.get(['apiBase']);
  $('apiBase').value = cfg.apiBase ?? '';
})();

$('save').addEventListener('click', async () => {
  const saveStatus = $('saveStatus');
  saveStatus.textContent = '';

  const raw = $('apiBase').value.trim();
  if (!raw) {
    saveStatus.textContent = 'Enter your app URL first.';
    return;
  }

  let apiBase;
  try {
    apiBase = normalizeApiBase(raw);
  } catch (err) {
    saveStatus.textContent = (err).message;
    return;
  }

  const current = await chrome.storage.local.get(['apiBase']);
  const currentPattern = current.apiBase ? toOriginPattern(current.apiBase) : null;
  const nextPattern = toOriginPattern(apiBase);
  const granted = await chrome.permissions.request({ origins: [nextPattern] });
  if (!granted) {
    saveStatus.textContent = 'Host permission is required to talk to your app.';
    return;
  }

  await chrome.storage.local.set({ apiBase });
  if (currentPattern && currentPattern !== nextPattern) {
    await chrome.permissions.remove({ origins: [currentPattern] });
  }

  chrome.runtime.sendMessage({ type: 'sync-hashes' });

  const ok = $('ok');
  ok.hidden = false;
  setTimeout(() => { ok.hidden = true; }, 1500);
  saveStatus.textContent = `Saved ${apiBase}`;
});

$('import').addEventListener('click', runImport);

async function runImport() {
  const btn = $('import');
  const status = $('importStatus');
  btn.disabled = true;
  status.textContent = 'Reading Chrome bookmarks…';

  const { apiBase } = await chrome.storage.local.get(['apiBase']);
  if (!apiBase) {
    status.textContent = 'Set and save the API base URL first.';
    btn.disabled = false;
    return;
  }

  const tree = await chrome.bookmarks.getTree();
  const items = flattenTree(tree);
  if (!items.length) {
    status.textContent = 'No bookmarks found.';
    btn.disabled = false;
    return;
  }

  status.textContent = `Found ${items.length} bookmarks. Importing…`;

  const BATCH = 50;
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    try {
      const r = await fetch(`${apiBase}/api/bookmarks/import`, {
        method: 'POST',
        credentials: 'include',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: chunk }),
      });
      if (r.type === 'opaqueredirect') {
        status.textContent = 'Session expired — opening dashboard to log in…';
        await chrome.tabs.create({ url: apiBase, active: true });
        btn.disabled = false;
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      imported += d.imported ?? 0;
      skipped += d.skipped ?? 0;
    } catch {
      failed += chunk.length;
    }
    const done = Math.min(i + BATCH, items.length);
    status.textContent = `${done}/${items.length} processed — imported ${imported}, skipped ${skipped}${failed ? `, failed ${failed}` : ''}`;
  }

  status.textContent = `Done. Imported ${imported}, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`;
  btn.disabled = false;
  chrome.runtime.sendMessage({ type: 'sync-hashes' });
}

// Walk the bookmark tree, emitting {url, title, tags} for every http(s) bookmark.
// tags = path of user-created folder titles from the synthetic root down.
function flattenTree(nodes, path = []) {
  const out = [];
  for (const node of nodes) {
    if (node.url) {
      if (/^https?:/i.test(node.url)) {
        out.push({ url: node.url, title: node.title || null, tags: path });
      }
      continue;
    }
    if (!node.children) continue;
    const isSynthetic = !node.title || SYNTHETIC_ROOTS.has(node.title);
    const nextPath = isSynthetic ? path : [...path, node.title];
    out.push(...flattenTree(node.children, nextPath));
  }
  return out;
}

function normalizeApiBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a valid http(s) URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('API base URL must use http or https.');
  }

  return url.origin;
}

function toOriginPattern(apiBase) {
  return `${new URL(apiBase).origin}/*`;
}
