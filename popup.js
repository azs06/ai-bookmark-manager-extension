import { isTrackableUrl } from './lib/url.js';
import { summarizeOnDevice } from './lib/summarizers.js';

const status = document.getElementById('status');
const savedNote = document.getElementById('savedNote');
const saveBtn = document.getElementById('save');
const removeBtn = document.getElementById('remove');
const subscribeBtn = document.getElementById('subscribe');
const shortenBtn = document.getElementById('shortenCopy');
const candidatesEl = document.getElementById('candidates');
const queueNote = document.getElementById('queueNote');

const PENDING = Symbol('pending');

const activeTab = await getActiveTab();
const tabUrl = activeTab?.url;
const tabTitle = activeTab?.title;
const tabId = activeTab?.id;

// On-device summary starts as soon as the popup opens so it's already done
// (or close to it) by the time the user clicks Save. It only runs when the
// user opted in and the page isn't saved yet — otherwise nothing would use
// it. If the API isn't available, the model isn't downloaded, or anything
// fails, this resolves to null and the backend falls through to Gemma.
let summaryPreflight = Promise.resolve(null);

void sendMessage({ type: 'queue-status' }).then(renderQueueStatus);

if (!tabUrl) {
  status.textContent = 'No active tab.';
  saveBtn.hidden = false;
  saveBtn.disabled = true;
  subscribeBtn.disabled = true;
  shortenBtn.disabled = true;
} else if (!isTrackableUrl(tabUrl)) {
  status.textContent = "Can't save this kind of page.";
  saveBtn.hidden = false;
  saveBtn.disabled = true;
  subscribeBtn.disabled = true;
  shortenBtn.disabled = true;
} else {
  const [{ saved }, { onDeviceSummary }] = await Promise.all([
    sendMessage({ type: 'check-saved', url: tabUrl }),
    chrome.storage.local.get('onDeviceSummary'),
  ]);
  renderSavedState(saved);
  if (onDeviceSummary && !saved && tabId) {
    summaryPreflight = prepareSummary(tabId).catch(() => null);
  }
}

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  // Save is the deliberate "file this away" action, so it's worth briefly
  // waiting for a summary that's still being produced.
  const summary = await waitForSummary(4000);
  status.textContent = 'Saving…';
  const resp = await sendMessage({
    type: 'save',
    url: tabUrl,
    title: tabTitle,
    ...summaryFields(summary),
  });
  saveBtn.disabled = false;

  if (resp?.queued) {
    status.textContent = resp.authRequired
      ? 'Session expired — queued. It will save after you log in.'
      : `${resp.error ?? 'Temporary error.'} Queued for retry.`;
    sendMessage({ type: 'queue-status' }).then(renderQueueStatus);
    return;
  }
  if (!resp?.ok) {
    status.textContent = resp?.error ?? 'Error saving.';
    return;
  }

  status.textContent = resp.restored ? 'Restored ✓' : resp.duplicate ? 'Already saved ✓' : 'Saved ✓';
  renderSavedState(true);
});

removeBtn.addEventListener('click', async () => {
  status.textContent = 'Removing…';
  removeBtn.disabled = true;
  const resp = await sendMessage({ type: 'remove', url: tabUrl });
  removeBtn.disabled = false;

  if (resp?.authRequired) {
    status.textContent = 'Session expired — log in, then try again.';
    return;
  }
  if (!resp?.ok) {
    status.textContent = resp?.error ?? 'Error removing.';
    return;
  }

  status.textContent = resp.removed ? 'Removed ✓' : 'Not in library.';
  renderSavedState(false);
});

shortenBtn.addEventListener('click', async () => {
  shortenBtn.disabled = true;
  // Shorten-and-copy is latency-sensitive: use a summary only if it's
  // already ready rather than holding the copy behind the model.
  const summary = await waitForSummary(0);
  status.textContent = 'Shortening…';
  const resp = await sendMessage({
    type: 'shortenCopy',
    url: tabUrl,
    title: tabTitle,
    ...summaryFields(summary),
  });
  shortenBtn.disabled = false;

  if (resp?.queued) {
    // Server has to mint the code, so we can't synthesize a short URL
    // offline. Tell the user the save was queued and to come back.
    status.textContent = resp.authRequired
      ? 'Session expired — queued. Log in, then reopen this popup to copy the short URL.'
      : 'Saved offline — short URL will be ready when you’re back online. Reopen this popup to copy.';
    sendMessage({ type: 'queue-status' }).then(renderQueueStatus);
    return;
  }
  if (!resp?.ok || !resp?.short_url) {
    status.textContent = resp?.error ?? 'Shorten failed.';
    return;
  }

  try {
    await navigator.clipboard.writeText(resp.short_url);
    showShortUrl('Copied: ', resp.short_url);
  } catch {
    // Clipboard write blocked (e.g. the popup lost focus during the request).
    // A click is a fresh user gesture, so retry the copy from there.
    const code = showShortUrl('Click to copy: ', resp.short_url);
    code.classList.add('copyable');
    code.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(resp.short_url);
        showShortUrl('Copied: ', resp.short_url);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        status.firstChild.textContent = 'Selected — press Ctrl/⌘+C: ';
      }
    });
  }
  renderSavedState(true);
});

function showShortUrl(label, shortUrl) {
  const code = document.createElement('code');
  code.textContent = shortUrl;
  status.replaceChildren(document.createTextNode(label), code);
  return code;
}

subscribeBtn.addEventListener('click', () => void trySubscribe(tabUrl));

// Kicks off subscription. Either the backend commits, asks which feed to
// follow (candidates), or reports the feed is already in the library.
async function trySubscribe(url) {
  setStatus('Subscribing…');
  subscribeBtn.disabled = true;
  candidatesEl.classList.remove('show');
  candidatesEl.innerHTML = '';

  const resp = await sendMessage({ type: 'subscribe', url });
  subscribeBtn.disabled = false;

  if (resp?.authRequired) {
    setStatus('Session expired — log in, then try again.');
    return;
  }
  if (resp?.candidates?.length) {
    setStatus('Multiple feeds found — pick one:');
    renderCandidates(resp.candidates);
    return;
  }
  if (resp?.alreadySubscribed) {
    renderAlreadySubscribed(resp.feedId);
    return;
  }
  if (!resp?.ok) {
    setStatus(resp?.error ?? 'Subscribe failed.');
    return;
  }
  setStatus(resp.feedTitle
    ? `Subscribed to ${resp.feedTitle} ✓`
    : 'Subscribed ✓');
}

function renderCandidates(candidates) {
  candidatesEl.innerHTML = '';
  for (const c of candidates) {
    const btn = document.createElement('button');
    btn.className = 'candidate';
    const title = document.createElement('span');
    title.className = 'candidate-title';
    title.textContent = c.title || c.url;
    const meta = document.createElement('span');
    meta.className = 'candidate-meta';
    meta.textContent = c.type && c.type !== 'unknown' ? `${c.type.toUpperCase()} · ${c.url}` : c.url;
    btn.append(title, meta);
    btn.addEventListener('click', () => void trySubscribe(c.url));
    candidatesEl.append(btn);
  }
  candidatesEl.classList.add('show');
}

async function renderAlreadySubscribed(feedId) {
  const { apiBase } = await chrome.storage.local.get(['apiBase']);
  status.textContent = 'Already subscribed. ';
  if (typeof feedId === 'number' && apiBase) {
    const link = document.createElement('a');
    link.textContent = 'View feed';
    link.href = '#';
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      await chrome.tabs.create({
        url: `${apiBase}/feeds?feed_id=${feedId}`,
        active: true,
      });
      window.close();
    });
    status.append(link);
  }
}

function setStatus(text) {
  status.textContent = text;
}

document.getElementById('openSite').addEventListener('click', async () => {
  const { apiBase } = await chrome.storage.local.get(['apiBase']);
  if (!apiBase) {
    status.textContent = 'Set the API base URL in settings first.';
    chrome.runtime.openOptionsPage();
    return;
  }
  await chrome.tabs.create({ url: apiBase, active: true });
  window.close();
});

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

function renderSavedState(saved) {
  savedNote.hidden = !saved;
  saveBtn.hidden = saved;
  removeBtn.hidden = !saved;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      // lastError is only readable inside this callback.
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp ?? {});
    });
  });
}

// Shows how many saves are waiting in the offline queue, and any queued saves
// the server permanently rejected so they don't vanish silently.
function renderQueueStatus({ queued = 0, failed = [] } = {}) {
  queueNote.replaceChildren();
  if (queued) {
    queueNote.append(`${queued} save${queued === 1 ? '' : 's'} waiting to sync. `);
  }
  if (failed.length) {
    const [latest] = failed;
    queueNote.append(
      `${failed.length} queued save${failed.length === 1 ? '' : 's'} couldn't sync (latest: ${latest.url} — ${latest.error}). `,
    );
    const dismiss = document.createElement('a');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', async () => {
      await sendMessage({ type: 'dismiss-failed' });
      renderQueueStatus(await sendMessage({ type: 'queue-status' }));
    });
    queueNote.append(dismiss);
  }
  queueNote.hidden = !queueNote.childNodes.length;
}

function summaryFields(summary) {
  return summary ? { ai_summary: summary.summary, summary_source: summary.source } : {};
}

// Pulls a chunk of readable text from the active tab. Walks main → article →
// body so we send the meaty part to the summarizer rather than nav chrome.
// Capped at 8000 chars: more than enough for tldr quality, keeps the call
// fast on long pages, and stays well under the model's input window.
async function extractPageText(targetTabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: () => {
      const root = document.querySelector('main, article, [role="main"]') ?? document.body;
      const text = (root?.innerText ?? '').trim();
      return text.slice(0, 8000);
    },
  });
  return result || '';
}

async function prepareSummary(targetTabId) {
  const text = await extractPageText(targetTabId);
  if (text.length < 200) return null; // too little signal — let Gemma handle it
  return summarizeOnDevice(text);
}

// Returns the preflight summary if it settles within maxWaitMs, else null.
// Shows "Summarizing…" only if the preflight isn't already (nearly) done.
// Callers cap the wait — beyond that the user expects the click to do
// something, and Gemma will produce a summary on the backend anyway.
async function waitForSummary(maxWaitMs) {
  const fast = await raceTimeout(summaryPreflight, 150, PENDING);
  if (fast !== PENDING) return fast;
  if (!maxWaitMs) return null;

  status.textContent = 'Summarizing…';
  return raceTimeout(summaryPreflight, maxWaitMs, null);
}

function raceTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}
