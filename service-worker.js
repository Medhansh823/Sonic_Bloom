chrome.action.onClicked.addListener(tab => {
  if (!Number.isInteger(tab.id)) return;

  const url = new URL(chrome.runtime.getURL('index.html'));
  url.searchParams.set('captureTabId', String(tab.id));
  chrome.tabs.create({ url: url.toString() });
});
