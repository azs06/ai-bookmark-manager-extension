import { isTrackableUrl } from './lib/url.js';
import { summarizeOnDevice } from './lib/summarizers.js';

const status = document.getElementById('status');
const savedNote = document.getElementById('savedNote');
const saveBtn = document.getElementById('save');
const removeBtn = document.getElementById('remove');
const subscribeBtn = document.getElementById('subscribe');
const shortenBtn = document.getElementById('shortenCopy');
const candidatesEl = document.getElementById('candidates');

const activeTab = await getActiveTab();
const tabUrl = activeTab?.url;
const tabTitle = activeTab?.title;
const tabId = activeTab?.id;

// On-device summary runs in parallel with check-saved so it's already done
// (or close to it) by the time the user clicks Save. If the API isn't
// available, the model isn't downloaded, or anything fails, this resolves
// to null and the backend falls through to Gemma normally.
const summaryPreflight = (tabUrl && isTrackableUrl(tabUrl) && tabId)
  ? prepareSummary(tabId).catch(() => null)
  : Promise.resolve(null);

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
  const { saved } = await sendMessage({ type: 'check-saved', url: tabUrl });
  renderSavedState(saved);
}

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  const summary = await waitForSummaryWithStatus();
  status.textContent = 'Saving…';
  const resp = await sendMessage({
    type: 'save',
    url: tabUrl,
    title: tabTitle,
    ...(summary ? { ai_summary: summary.summary, summary_source: summary.source } : {}),
  });
  saveBtn.disabled = false;

  if (chrome.runtime.lastError) {
    status.textContent = 'Queued (offline). Will sync later.';
    return;
  }
  if (resp?.authRequired) {
    status.textContent = 'Session expired — log in, then click Save again.';
    return;
  }
  if (!resp?.ok) {
    status.textContent = resp?.queued
      ? `${resp.error ?? 'Temporary error.'} Queued for retry.`
      : (resp?.error ?? 'Error saving.');
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
  const summary = await waitForSummaryWithStatus();
  status.textContent = 'Shortening…';
  const resp = await sendMessage({
    type: 'shortenCopy',
    url: tabUrl,
    title: tabTitle,
    ...(summary ? { ai_summary: summary.summary, summary_source: summary.source } : {}),
  });
  shortenBtn.disabled = false;

  if (resp?.authRequired) {
    status.textContent = 'Session expired — log in, then try again.';
    return;
  }
  if (resp?.queued) {
    // Server has to mint the code, so we can't synthesize a short URL
    // offline. Tell the user the save was queued and to come back.
    status.textContent = 'Saved offline — short URL will be ready when you’re back online. Reopen this popup to copy.';
    return;
  }
  if (!resp?.ok || !resp?.short_url) {
    status.textContent = resp?.error ?? 'Shorten failed.';
    return;
  }

  try {
    await navigator.clipboard.writeText(resp.short_url);
    status.innerHTML = '';
    const label = document.createTextNode('Copied: ');
    const code = document.createElement('code');
    code.textContent = resp.short_url;
    status.append(label, code);
  } catch {
    // Clipboard write blocked (rare in popup user-gesture context). Show
    // the URL so the user can copy it manually instead of silently failing.
    status.innerHTML = '';
    const label = document.createTextNode('Tap to copy: ');
    const code = document.createElement('code');
    code.textContent = resp.short_url;
    status.append(label, code);
  }
  renderSavedState(true);
});

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
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp ?? {}));
  });
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

// Show a "Summarizing…" status only if the preflight isn't already done.
// Caps the wait at 4s — beyond that the user expects the click to do something
// and Gemma will produce a summary on the backend anyway.
async function waitForSummaryWithStatus() {
  const fast = await Promise.race([
    summaryPreflight,
    new Promise((r) => setTimeout(() => r('pending'), 150)),
  ]);
  if (fast !== 'pending') return fast;

  status.textContent = 'Summarizing…';
  const slow = await Promise.race([
    summaryPreflight,
    new Promise((r) => setTimeout(() => r(null), 4000)),
  ]);
  return slow;
}
