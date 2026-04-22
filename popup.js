import { isTrackableUrl } from './lib/url.js';

const status = document.getElementById('status');
const savedNote = document.getElementById('savedNote');
const saveBtn = document.getElementById('save');
const removeBtn = document.getElementById('remove');

const activeTab = await getActiveTab();
const tabUrl = activeTab?.url;
const tabTitle = activeTab?.title;

if (!tabUrl) {
  status.textContent = 'No active tab.';
  saveBtn.hidden = false;
  saveBtn.disabled = true;
} else if (!isTrackableUrl(tabUrl)) {
  status.textContent = "Can't save this kind of page.";
  saveBtn.hidden = false;
  saveBtn.disabled = true;
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
