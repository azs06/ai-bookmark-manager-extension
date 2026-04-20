const status = document.getElementById('status');

document.getElementById('save').addEventListener('click', async () => {
  status.textContent = 'Saving…';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    status.textContent = 'No active tab.';
    return;
  }
  chrome.runtime.sendMessage(
    { type: 'save', url: tab.url, title: tab.title },
    (resp) => {
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
      } else {
        status.textContent = resp.restored
          ? 'Restored ✓'
          : resp.duplicate
            ? 'Already saved ✓'
            : 'Saved ✓';
      }
    },
  );
});

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
