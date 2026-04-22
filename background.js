import { normalizeUrl, hashUrl, isTrackableUrl } from './lib/url.js';

const QUEUE_KEY = 'save_queue';
const SAVED_HASHES_KEY = 'saved_hashes';
const FLUSH_ALARM = 'flushQueue';
const SYNC_ALARM = 'syncHashes';
const SYNC_PERIOD_MIN = 15;

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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 10 });
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN });
  syncSavedHashes();
});

chrome.runtime.onStartup.addListener(() => {
  syncSavedHashes();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'save') {
    handleSave(msg).then(sendResponse);
    return true; // keep channel open for async reply
  }
  if (msg?.type === 'sync-hashes') {
    syncSavedHashes().then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) flushQueue();
  if (alarm.name === SYNC_ALARM) syncSavedHashes();
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

async function handleSave({ url, title }) {
  try {
    const resp = await postBookmark({ url, title });
    await recordSavedUrl(url);
    return { ok: true, ...resp };
  } catch (err) {
    if (err?.authRequired) {
      await enqueue({ url, title, ts: Date.now() });
      await openDashboard();
      return { ok: false, authRequired: true, queued: true, error: err.message };
    }
    if (err?.transient) {
      await enqueue({ url, title, ts: Date.now() });
      chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 1 });
      return { ok: false, queued: true, error: err.message };
    }
    return { ok: false, error: err?.message ?? 'Save failed' };
  }
}

// Cookie-based auth: credentials: 'include' sends the CF_Authorization cookie
// the user picked up when they logged into the PWA. redirect: 'manual' lets us
// detect an expired session — CF Access responds with a 302 to its login page,
// which surfaces as an opaqueredirect response.
async function postBookmark(body) {
  const { apiBase } = await chrome.storage.local.get(['apiBase']);
  if (!apiBase) {
    throw makeError('Open settings and configure the API base URL first.', { retryable: true });
  }

  let r;
  try {
    r = await fetch(`${apiBase}/api/bookmarks`, {
      method: 'POST',
      credentials: 'include',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw makeError('Network error while saving bookmark.', { transient: true });
  }

  if (r.type === 'opaqueredirect') {
    throw makeError('Session expired. Log in to AI Bookmarks again.', { authRequired: true });
  }
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      throw makeError('Session expired. Log in to AI Bookmarks again.', { authRequired: true });
    }

    const message = await readErrorMessage(r);
    if (r.status === 408 || r.status === 429 || r.status >= 500) {
      throw makeError(message, { transient: true });
    }

    throw makeError(message);
  }
  return r.json();
}

async function openDashboard() {
  const { apiBase } = await chrome.storage.local.get(['apiBase']);
  if (!apiBase) return;
  await chrome.tabs.create({ url: apiBase, active: true });
}

async function enqueue(item) {
  const data = await chrome.storage.local.get(QUEUE_KEY);
  const queue = data[QUEUE_KEY] || [];
  queue.push(item);
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function flushQueue() {
  const data = await chrome.storage.local.get(QUEUE_KEY);
  const queue = data[QUEUE_KEY] || [];
  if (!queue.length) return;

  const remaining = [];
  for (const item of queue) {
    try {
      await postBookmark(item);
      await recordSavedUrl(item.url);
    } catch (err) {
      // If auth is expired, don't pound on the gate for every queued item.
      // Stop the flush; user will drain the queue after re-login.
      if (err?.authRequired) {
        remaining.push(item);
        remaining.push(...queue.slice(queue.indexOf(item) + 1));
        break;
      }
      if (err?.transient || err?.retryable) {
        remaining.push(item);
      }
    }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
  if (remaining.length) {
    chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 5 });
  }
}

// Apply the same normalization + hashing the backend uses, then add to the
// local cache. Mirrored logic in lib/url.js keeps these hashes identical to
// the server's url_hash column, so a full sync won't produce duplicates.
async function recordSavedUrl(rawUrl) {
  if (!isTrackableUrl(rawUrl)) return;
  try {
    const hash = await hashUrl(normalizeUrl(rawUrl));
    const { [SAVED_HASHES_KEY]: list } = await chrome.storage.local.get(SAVED_HASHES_KEY);
    const set = new Set(Array.isArray(list) ? list : []);
    if (set.has(hash)) return;
    set.add(hash);
    await chrome.storage.local.set({ [SAVED_HASHES_KEY]: [...set] });
  } catch {
    // Ignore; next full sync will reconcile.
  }
  await refreshActiveTabIcon();
}

async function syncSavedHashes() {
  const { apiBase } = await chrome.storage.local.get(['apiBase']);
  if (!apiBase) return;

  let r;
  try {
    r = await fetch(`${apiBase}/api/bookmarks/hashes`, {
      credentials: 'include',
      redirect: 'manual',
    });
  } catch {
    return; // leave cached list untouched on network failure
  }
  if (r.type === 'opaqueredirect' || !r.ok) return;

  let data;
  try {
    data = await r.json();
  } catch {
    return;
  }
  if (!Array.isArray(data?.hashes)) return;

  await chrome.storage.local.set({ [SAVED_HASHES_KEY]: data.hashes });
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
    const { [SAVED_HASHES_KEY]: list } = await chrome.storage.local.get(SAVED_HASHES_KEY);
    return Array.isArray(list) && list.includes(hash);
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
