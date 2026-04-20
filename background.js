const QUEUE_KEY = 'save_queue';
const FLUSH_ALARM = 'flushQueue';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 10 });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'save') {
    handleSave(msg).then(sendResponse);
    return true; // keep channel open for async reply
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) flushQueue();
});

async function handleSave({ url, title }) {
  try {
    const resp = await postBookmark({ url, title });
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
