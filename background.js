import { normalizeUrl, hashUrl, isTrackableUrl } from './lib/url.js';
import { flattenBookmarkTree } from './lib/bookmarks.js';

const QUEUE_KEY = 'save_queue';
const FAILED_SAVES_KEY = 'failed_saves';
const SAVED_HASHES_KEY = 'saved_hashes';
const HASHES_ETAG_KEY = 'saved_hashes_etag';
const IMPORT_STATUS_KEY = 'import_status';

// The periodic flush and the one-shot retry need distinct names:
// alarms.create() with an existing name replaces that alarm, so reusing the
// periodic name for a retry would silently cancel the periodic schedule.
const FLUSH_ALARM = 'flushQueue';
const FLUSH_RETRY_ALARM = 'flushQueueRetry';
const SYNC_ALARM = 'syncHashes';
const FLUSH_PERIOD_MIN = 10;
const SYNC_PERIOD_MIN = 15;

const QUEUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FAILED_SAVES_MAX = 20;
const IMPORT_BATCH = 50;
const IMPORT_MAX_ATTEMPTS = 3;

const SESSION_EXPIRED = 'Session expired. Log in to AI Bookmarks again.';

const DEFAULT_ICON = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};
const SAVED_ICON = {
  16: 'icons/icon-16-saved.png',
  32: 'icons/icon-32-saved.png',
  48: 'icons/icon-48-saved.png',
  128: 'icons/icon-128-saved.png',
};
const DEFAULT_TITLE = 'Save to AI Bookmarks';
const SAVED_TITLE = 'Already saved · AI Bookmarks';

chrome.runtime.onInstalled.addListener(onBrowserOrExtensionStart);
chrome.runtime.onStartup.addListener(onBrowserOrExtensionStart);

function onBrowserOrExtensionStart() {
  ensureAlarms();
  syncSavedHashes();
  updateQueueBadge();
}

const HANDLERS = new Map([
  ['save', (msg) => handleSave(msg)],
  ['shortenCopy', (msg) => handleSave(msg, { autoShorten: true })],
  ['remove', handleRemove],
  ['subscribe', handleSubscribe],
  ['check-saved', async (msg) => ({ saved: await isUrlSaved(msg.url) })],
  ['sync-hashes', async () => { await syncSavedHashes(); return { ok: true }; }],
  ['queue-status', getQueueStatus],
  ['dismiss-failed', async () => {
    await chrome.storage.local.set({ [FAILED_SAVES_KEY]: [] });
    return { ok: true };
  }],
  ['import-bookmarks', startImport],
  ['import-status', getImportStatus],
]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS.get(msg?.type);
  if (!handler) return;
  handler(msg).then(
    sendResponse,
    (err) => sendResponse({ ok: false, error: err?.message ?? String(err) }),
  );
  return true; // keep channel open for async reply
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM || alarm.name === FLUSH_RETRY_ALARM) flushQueue();
  if (alarm.name === SYNC_ALARM) syncSavedHashes();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SAVED_HASHES_KEY in changes) hashCache = null;
});

// Icon state is per-tab. When the user switches tabs or a tab navigates, we
// check the tab's URL against the local cache and swap the action icon.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateIconForTab(tabId, tab.url);
  } catch {
    // Tab may have closed between the event and the get().
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // onUpdated fires repeatedly during a navigation (loading, url change,
  // complete). Only act when the URL changes or the page finishes loading —
  // either signal means the normalized URL is in its final form.
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  updateIconForTab(tabId, tab.url);
});

// Alarms survive service-worker restarts but aren't guaranteed to survive a
// browser restart, and builds before the retry alarm got its own name may
// have left FLUSH_ALARM as a one-shot. Recreate anything missing or one-shot
// without resetting a healthy periodic schedule.
async function ensureAlarms() {
  const flush = await chrome.alarms.get(FLUSH_ALARM);
  if (!flush?.periodInMinutes) {
    chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MIN });
  }
  const sync = await chrome.alarms.get(SYNC_ALARM);
  if (!sync?.periodInMinutes) {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN });
  }
}

// Serializes read-modify-write cycles on a storage key. The service worker is
// single-threaded, but every await is a yield point where another handler can
// read the same key and later overwrite our write.
const locks = new Map();
function withLock(name, fn) {
  const run = (locks.get(name) ?? Promise.resolve()).then(() => fn());
  locks.set(name, run.catch(() => {}));
  return run;
}

// Save and shorten share one path; shorten just asks the server to mint a
// short code (returned inline as short_url). On transient or auth failure the
// request is queued with auto_shorten persisted, so the flush mints the code.
async function handleSave({ url, title, ai_summary, summary_source }, { autoShorten = false } = {}) {
  const body = toBookmarkBody({ url, title, auto_shorten: autoShorten, ai_summary, summary_source });
  try {
    const resp = await postBookmark(body);
    await recordSavedUrl(url);
    flushQueue(); // we're online and authenticated — drain anything waiting
    return { ok: true, ...resp };
  } catch (err) {
    if (err?.authRequired || err?.transient) {
      await enqueue({ ...body, ts: Date.now() });
      if (err.authRequired) {
        await openDashboard();
      } else {
        chrome.alarms.create(FLUSH_RETRY_ALARM, { delayInMinutes: 1 });
      }
      return { ok: false, queued: true, authRequired: !!err.authRequired, error: err.message };
    }
    return { ok: false, error: err?.message ?? (autoShorten ? 'Shorten failed' : 'Save failed') };
  }
}

// Projects to the API body shape so queue bookkeeping (id, ts) and unknown
// future fields never leak into requests.
function toBookmarkBody({ url, title, auto_shorten, ai_summary, summary_source }) {
  return {
    url,
    title,
    ...(auto_shorten ? { auto_shorten: true } : {}),
    ...(ai_summary ? { ai_summary, summary_source } : {}),
  };
}

// Remove is not queued on transient failure — unlike save, the user expects an
// immediate success/failure answer and the action is cheap to retry manually.
async function handleRemove({ url }) {
  try {
    const resp = await apiPost('/api/bookmarks/remove', { url }, 'Network error while removing bookmark.');
    await forgetSavedUrl(url);
    return { ok: true, ...resp };
  } catch (err) {
    if (err?.authRequired) {
      await openDashboard();
      return { ok: false, authRequired: true, error: err.message };
    }
    return { ok: false, error: err?.message ?? 'Remove failed' };
  }
}

// Subscribe translates the backend's three success/near-success shapes into
// a single flat response for the popup: candidates list, already-subscribed
// with feed_id, or committed subscription.
async function handleSubscribe({ url }) {
  try {
    const resp = await postFeed({ url });
    if (resp.candidates) {
      return { ok: false, candidates: resp.candidates };
    }
    if (resp.alreadySubscribed) {
      return { ok: false, alreadySubscribed: true, feedId: resp.feedId ?? null };
    }
    return {
      ok: true,
      feedTitle: resp.body?.feed?.title ?? null,
      itemsAdded: resp.body?.items_added ?? 0,
    };
  } catch (err) {
    if (err?.authRequired) {
      await openDashboard();
      return { ok: false, authRequired: true, error: err.message };
    }
    return { ok: false, error: err?.message ?? 'Subscribe failed' };
  }
}

function postBookmark(body) {
  return apiPost('/api/bookmarks', body, 'Network error while saving bookmark.');
}

async function postFeed(body) {
  const r = await apiRequest('/api/feeds', {
    method: 'POST',
    body,
    networkError: 'Network error while subscribing.',
  });

  // 300 multiple-choices: page exposes >1 feed. Return the list untouched.
  if (r.status === 300) {
    const data = await safeJson(r);
    return { candidates: Array.isArray(data?.candidates) ? data.candidates : [] };
  }
  // 409: already subscribed. Surface the existing feed_id for the deep link.
  if (r.status === 409) {
    const data = await safeJson(r);
    return { alreadySubscribed: true, feedId: typeof data?.feed_id === 'number' ? data.feed_id : null };
  }
  if (!r.ok) throw await httpError(r);
  return { body: await r.json() };
}

async function apiPost(path, body, networkError) {
  const r = await apiRequest(path, { method: 'POST', body, networkError });
  if (!r.ok) throw await httpError(r);
  return r.json();
}

// Cookie-based auth: credentials: 'include' sends the CF_Authorization cookie
// the user picked up when they logged into the PWA. redirect: 'manual' lets us
// detect an expired session — CF Access responds with a 302 to its login page,
// which surfaces as an opaqueredirect response.
async function apiRequest(path, { method = 'GET', body, headers = {}, networkError = 'Network error.' } = {}) {
  const apiBase = await getApiBase();
  if (!apiBase) {
    throw makeError('Open settings and configure the API base URL first.', { retryable: true });
  }

  let r;
  try {
    r = await fetch(`${apiBase}${path}`, {
      method,
      credentials: 'include',
      redirect: 'manual',
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw makeError(networkError, { transient: true });
  }

  if (r.type === 'opaqueredirect' || r.status === 401 || r.status === 403) {
    throw makeError(SESSION_EXPIRED, { authRequired: true });
  }
  return r;
}

async function httpError(response) {
  const message = await readErrorMessage(response);
  const transient = response.status === 408 || response.status === 429 || response.status >= 500;
  return makeError(message, { transient });
}

async function safeJson(response) {
  try { return await response.clone().json(); } catch { return null; }
}

async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get(['apiBase']);
  return apiBase || null;
}

// Re-uses an open dashboard tab rather than opening one per failed click.
// The reload sends the expired session through the login redirect.
async function openDashboard() {
  const apiBase = await getApiBase();
  if (!apiBase) return;
  try {
    const [existing] = await chrome.tabs.query({ url: `${new URL(apiBase).origin}/*` });
    if (existing?.id) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
      await chrome.tabs.reload(existing.id);
      return;
    }
  } catch {
    // Fall through to a fresh tab.
  }
  await chrome.tabs.create({ url: apiBase, active: true });
}

// ---------------------------------------------------------------------------
// Offline queue
// ---------------------------------------------------------------------------

async function readQueue() {
  const { [QUEUE_KEY]: queue } = await chrome.storage.local.get(QUEUE_KEY);
  return Array.isArray(queue) ? queue : [];
}

function queueMatchKey(rawUrl) {
  try { return normalizeUrl(rawUrl); } catch { return rawUrl; }
}

// Saving the same page twice while offline collapses into one queue entry.
// A merged entry gets a fresh id so a flush already in flight for the old
// entry doesn't remove it — the merged fields (e.g. auto_shorten) still go out.
async function enqueue(item) {
  const key = queueMatchKey(item.url);
  const length = await withLock(QUEUE_KEY, async () => {
    const queue = await readQueue();
    const idx = queue.findIndex((q) => queueMatchKey(q.url) === key);
    if (idx >= 0) {
      const prev = queue[idx];
      queue[idx] = {
        ...prev,
        ...item,
        id: crypto.randomUUID(),
        auto_shorten: !!(prev.auto_shorten || item.auto_shorten),
        ai_summary: item.ai_summary ?? prev.ai_summary,
        summary_source: item.ai_summary ? item.summary_source : prev.summary_source,
      };
    } else {
      queue.push({ ...item, id: crypto.randomUUID() });
    }
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
    return queue.length;
  });
  await updateQueueBadge(length);
}

// Single-flight: the periodic alarm, the retry alarm and post-save drains can
// all fire close together; overlapping flushes would double-post.
let flushInFlight = null;
function flushQueue() {
  flushInFlight ??= drainQueue().finally(() => { flushInFlight = null; });
  return flushInFlight;
}

// Network calls happen outside the queue lock so saves from the popup aren't
// blocked behind a slow flush. Afterwards only the entries this pass resolved
// are removed from the *current* queue, so anything enqueued meanwhile stays.
async function drainQueue() {
  const queue = await withLock(QUEUE_KEY, async () => {
    const q = await readQueue();
    if (q.some((item) => !item.id)) {
      // Entries queued by older builds have no id; assign them once.
      for (const item of q) item.id ??= crypto.randomUUID();
      await chrome.storage.local.set({ [QUEUE_KEY]: q });
    }
    return q;
  });
  if (!queue.length) return;

  const resolved = new Set();
  const failures = [];
  const now = Date.now();
  for (const item of queue) {
    if (now - (item.ts ?? now) > QUEUE_MAX_AGE_MS) {
      resolved.add(item.id);
      failures.push({ url: item.url, error: 'Gave up after 30 days in the offline queue.', ts: now });
      continue;
    }
    try {
      await postBookmark(toBookmarkBody(item));
      await recordSavedUrl(item.url);
      resolved.add(item.id);
    } catch (err) {
      // If auth is expired, don't pound on the gate for every queued item.
      // Stop the flush; the queue drains after re-login.
      if (err?.authRequired) break;
      if (!err?.transient && !err?.retryable) {
        resolved.add(item.id);
        failures.push({ url: item.url, error: err?.message ?? 'Save failed', ts: now });
      }
    }
  }

  const remaining = await withLock(QUEUE_KEY, async () => {
    const rest = (await readQueue()).filter((item) => !resolved.has(item.id));
    await chrome.storage.local.set({ [QUEUE_KEY]: rest });
    return rest.length;
  });
  if (failures.length) await recordFailures(failures);
  await updateQueueBadge(remaining);
  if (remaining) {
    chrome.alarms.create(FLUSH_RETRY_ALARM, { delayInMinutes: 5 });
  }
}

// Queued saves the server permanently rejected are kept (newest first) so the
// popup can tell the user instead of dropping them silently.
async function recordFailures(entries) {
  await withLock(FAILED_SAVES_KEY, async () => {
    const { [FAILED_SAVES_KEY]: list } = await chrome.storage.local.get(FAILED_SAVES_KEY);
    const prev = Array.isArray(list) ? list : [];
    await chrome.storage.local.set({
      [FAILED_SAVES_KEY]: [...entries, ...prev].slice(0, FAILED_SAVES_MAX),
    });
  });
}

async function getQueueStatus() {
  const { [FAILED_SAVES_KEY]: failed } = await chrome.storage.local.get(FAILED_SAVES_KEY);
  return {
    queued: (await readQueue()).length,
    failed: Array.isArray(failed) ? failed : [],
  };
}

async function updateQueueBadge(count) {
  count ??= (await readQueue()).length;
  try {
    await chrome.action.setBadgeText({ text: count ? String(count) : '' });
    if (count) await chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
  } catch {
    // Badge is cosmetic.
  }
}

// ---------------------------------------------------------------------------
// Saved-URL hash cache
// ---------------------------------------------------------------------------

// In-memory mirror of SAVED_HASHES_KEY so tab events don't deserialize the
// whole list on every navigation. Invalidated by storage.onChanged.
let hashCache = null;
function getSavedHashes() {
  hashCache ??= chrome.storage.local.get(SAVED_HASHES_KEY).then(
    ({ [SAVED_HASHES_KEY]: list }) => new Set(Array.isArray(list) ? list : []),
  );
  return hashCache;
}

async function writeSavedHashes(set, extra = {}) {
  hashCache = Promise.resolve(set);
  await chrome.storage.local.set({ [SAVED_HASHES_KEY]: [...set], ...extra });
}

function recordSavedUrl(rawUrl) {
  return setUrlSaved(rawUrl, true);
}

function forgetSavedUrl(rawUrl) {
  return setUrlSaved(rawUrl, false);
}

// Applies the same normalization + hashing the backend uses. Mirrored logic in
// lib/url.js keeps these hashes identical to the server's url_hash column, so a
// full sync won't produce duplicates.
async function setUrlSaved(rawUrl, saved) {
  if (!isTrackableUrl(rawUrl)) return;
  try {
    const hash = await hashUrl(normalizeUrl(rawUrl));
    syncOverlay?.set(hash, saved);
    await withLock(SAVED_HASHES_KEY, async () => {
      const set = new Set(await getSavedHashes());
      if (set.has(hash) === saved) return;
      if (saved) set.add(hash); else set.delete(hash);
      await writeSavedHashes(set);
    });
  } catch {
    // Ignore; next full sync will reconcile.
  }
  await refreshActiveTabIcon();
}

// Saves/removes that land while a sync request is in flight. The server's
// list was snapshotted before them, so they're replayed on top of it rather
// than being clobbered until the next sync.
let syncOverlay = null;
let syncInFlight = null;

function syncSavedHashes() {
  syncInFlight ??= fetchSavedHashes().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function fetchSavedHashes() {
  const apiBase = await getApiBase();
  if (!apiBase) return;

  // The ETag is only meaningful against the server that issued it.
  const { [HASHES_ETAG_KEY]: cached } = await chrome.storage.local.get(HASHES_ETAG_KEY);
  const etag = cached?.apiBase === apiBase ? cached.etag : null;

  syncOverlay = new Map();
  try {
    let r;
    try {
      r = await apiRequest('/api/bookmarks/hashes', {
        headers: etag ? { 'If-None-Match': etag } : {},
      });
    } catch {
      return; // leave cached list untouched when offline or logged out
    }
    if (r.status !== 304) {
      if (!r.ok) return;
      const data = await safeJson(r);
      if (!Array.isArray(data?.hashes)) return;

      const nextEtag = r.headers.get('ETag');
      await withLock(SAVED_HASHES_KEY, async () => {
        const set = new Set(data.hashes);
        for (const [hash, saved] of syncOverlay) {
          if (saved) set.add(hash); else set.delete(hash);
        }
        await writeSavedHashes(set, {
          [HASHES_ETAG_KEY]: nextEtag ? { apiBase, etag: nextEtag } : null,
        });
      });
    }
  } finally {
    syncOverlay = null;
  }

  // A successful sync proves the session is valid — drain saves that were
  // queued while logged out.
  flushQueue();
  await refreshActiveTabIcon();
}

async function updateIconForTab(tabId, rawUrl) {
  const saved = await isUrlSaved(rawUrl);
  try {
    await chrome.action.setIcon({
      tabId,
      path: saved ? SAVED_ICON : DEFAULT_ICON,
    });
    await chrome.action.setTitle({
      tabId,
      title: saved ? SAVED_TITLE : DEFAULT_TITLE,
    });
  } catch {
    // Tab may have closed.
  }
}

async function isUrlSaved(rawUrl) {
  if (!isTrackableUrl(rawUrl)) return false;
  try {
    const hash = await hashUrl(normalizeUrl(rawUrl));
    return (await getSavedHashes()).has(hash);
  } catch {
    return false;
  }
}

async function refreshActiveTabIcon() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await updateIconForTab(tab.id, tab.url);
  } catch {
    // No active tab or permission denied.
  }
}

// ---------------------------------------------------------------------------
// Chrome bookmark import
// ---------------------------------------------------------------------------

// Runs in the service worker rather than the options page so closing the
// settings tab doesn't abort it. Progress goes to storage.session, which the
// options page watches.
let importInFlight = null;

async function startImport() {
  if (!importInFlight) {
    importInFlight = runImport()
      .catch((err) => setImportStatus({ state: 'error', message: err?.message ?? 'Import failed.' }))
      .finally(() => { importInFlight = null; });
  }
  return { ok: true };
}

async function getImportStatus() {
  const { [IMPORT_STATUS_KEY]: status } = await chrome.storage.session.get(IMPORT_STATUS_KEY);
  return { running: !!importInFlight, status: status ?? null };
}

function setImportStatus(status) {
  return chrome.storage.session.set({ [IMPORT_STATUS_KEY]: status });
}

async function runImport() {
  await setImportStatus({ state: 'running' });

  if (!(await getApiBase())) {
    await setImportStatus({ state: 'error', message: 'Set and save the API base URL first.' });
    return;
  }

  const items = flattenBookmarkTree(await chrome.bookmarks.getTree());
  if (!items.length) {
    await setImportStatus({ state: 'error', message: 'No bookmarks found.' });
    return;
  }

  const totals = { total: items.length, done: 0, imported: 0, skipped: 0, failed: 0 };
  await setImportStatus({ state: 'running', ...totals });

  for (let i = 0; i < items.length; i += IMPORT_BATCH) {
    const chunk = items.slice(i, i + IMPORT_BATCH);
    try {
      const d = await importBatch(chunk);
      totals.imported += d.imported ?? 0;
      totals.skipped += d.skipped ?? 0;
    } catch (err) {
      if (err?.authRequired) {
        await setImportStatus({
          state: 'error',
          ...totals,
          message: `Session expired after ${i}/${items.length}. Log in, then run the import again — already-imported bookmarks are skipped.`,
        });
        await openDashboard();
        return;
      }
      totals.failed += chunk.length;
    }
    totals.done = Math.min(i + IMPORT_BATCH, items.length);
    await setImportStatus({ state: 'running', ...totals });
  }

  await setImportStatus({ state: 'done', ...totals });
  await syncSavedHashes();
}

async function importBatch(chunk) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await apiPost('/api/bookmarks/import', { items: chunk }, 'Network error while importing.');
    } catch (err) {
      if (!err?.transient || attempt >= IMPORT_MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

function makeError(message, details = {}) {
  const err = new Error(message);
  Object.assign(err, details);
  return err;
}

async function readErrorMessage(response) {
  try {
    const data = await response.clone().json();
    if (typeof data?.error === 'string' && data.error.trim()) {
      return data.error;
    }
  } catch {
    // Fall back to text below.
  }

  try {
    const text = (await response.text()).trim();
    if (text) return text;
  } catch {
    // Ignore and use the status code fallback.
  }

  return `HTTP ${response.status}`;
}
