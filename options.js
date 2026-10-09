const $ = (id) => document.getElementById(id);

const IMPORT_STATUS_KEY = 'import_status';

// Plain http is only allowed where the manifest's optional_host_permissions
// can grant it; anything else must be https.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

(async () => {
  const cfg = await chrome.storage.local.get(['apiBase', 'onDeviceSummary']);
  $('apiBase').value = cfg.apiBase ?? '';
  $('onDeviceSummary').checked = !!cfg.onDeviceSummary;

  const { running, status } = await chrome.runtime.sendMessage({ type: 'import-status' });
  if (status?.state === 'running' && !running) {
    // The service worker was restarted mid-import.
    renderImportStatus({
      state: 'error',
      message: 'The last import was interrupted. Run it again — already-imported bookmarks are skipped.',
    });
  } else {
    renderImportStatus(status);
  }
})();

$('onDeviceSummary').addEventListener('change', (e) => {
  chrome.storage.local.set({ onDeviceSummary: e.target.checked });
});

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
  let granted;
  try {
    granted = await chrome.permissions.request({ origins: [nextPattern] });
  } catch (err) {
    saveStatus.textContent = `Can't request access to ${nextPattern}: ${err?.message ?? err}`;
    return;
  }
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

$('import').addEventListener('click', () => {
  renderImportStatus({ state: 'running' });
  chrome.runtime.sendMessage({ type: 'import-bookmarks' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && IMPORT_STATUS_KEY in changes) {
    renderImportStatus(changes[IMPORT_STATUS_KEY].newValue);
  }
});

function renderImportStatus(s) {
  const btn = $('import');
  const status = $('importStatus');
  btn.disabled = s?.state === 'running';

  if (!s) {
    status.textContent = '';
  } else if (s.state === 'error') {
    status.textContent = s.message;
  } else if (s.state === 'running' && !s.total) {
    status.textContent = 'Reading Chrome bookmarks…';
  } else if (s.state === 'running') {
    status.textContent = `${s.done}/${s.total} processed — imported ${s.imported}, skipped ${s.skipped}${s.failed ? `, failed ${s.failed}` : ''}`;
  } else {
    status.textContent = `Done. Imported ${s.imported}, skipped ${s.skipped} duplicate${s.skipped === 1 ? '' : 's'}${s.failed ? `, ${s.failed} failed` : ''}.`;
  }
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
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('Use https — plain http is only supported for localhost and 127.0.0.1.');
  }

  // Keep the path so deployments under a subpath work; drop query, hash and
  // trailing slashes so `${apiBase}/api/...` joins cleanly.
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function toOriginPattern(apiBase) {
  return `${new URL(apiBase).origin}/*`;
}
