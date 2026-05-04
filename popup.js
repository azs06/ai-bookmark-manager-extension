import { isTrackableUrl } from './lib/url.js';

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
  status.textContent = 'Saving…';
  saveBtn.disabled = true;
  const resp = await sendMessage({ type: 'save', url: tabUrl, title: tabTitle });
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
  status.textContent = 'Shortening…';
  shortenBtn.disabled = true;
  const resp = await sendMessage({ type: 'shortenCopy', url: tabUrl, title: tabTitle });
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
