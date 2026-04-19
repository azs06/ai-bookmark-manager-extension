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
    await enqueue({ url, title, ts: Date.now() });
    if (err?.authRequired) {
      await openDashboard();
      return { ok: false, authRequired: true, queued: true };
    }
    chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 1 });
    return { ok: false, queued: true };
  }
}

// Cookie-based auth: credentials: 'include' sends the CF_Authorization cookie
// the user picked up when they logged into the PWA. redirect: 'manual' lets us
// detect an expired session — CF Access responds with a 302 to its login page,
// which surfaces as an opaqueredirect response.
async function postBookmark(body) {
  const { apiBase } = await chrome.storage.local.get(['apiBase']);
  if (!apiBase) throw new Error('apiBase not configured');

  const r = await fetch(`${apiBase}/api/bookmarks`, {
    method: 'POST',
    credentials: 'include',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (r.type === 'opaqueredirect') {
    const err = new Error('auth required');
    err.authRequired = true;
    throw err;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
      remaining.push(item);
      // If auth is expired, don't pound on the gate for every queued item.
      // Stop the flush; user will drain the queue after re-login.
      if (err?.authRequired) {
        remaining.push(...queue.slice(queue.indexOf(item) + 1));
        break;
      }
    }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
  if (remaining.length) {
    chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 5 });
  }
}
