/**
 * Re-injects content script on service worker startup (session restore, memory saver unfreeze),
 * extension installation, tab activation, and tab completion. Also includes guard to skip
 * re-injection if already loaded in tab. Each tab in a non-injectable state is swallowed.
 */

// ponytail: simple URL matcher for Jira issue pages
function isJiraUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.hostname.endsWith('.atlassian.net') &&
      (u.pathname.startsWith('/browse/') || u.pathname.startsWith('/jira/'))
    );
  } catch {
    return false;
  }
}

// ponytail: inject only if not already loaded in this tab
async function injectIfMissing(tabId: number): Promise<void> {
  try {
    // Check if already loaded via guard
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window as any).__jfvLoaded === true,
    });
    if (result[0]?.result === true) {
      return; // Already loaded, skip
    }
    // Not loaded, inject CSS then script
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch {
    // Tab is non-injectable (discarded, chrome://, etc.). Skip.
  }
}

async function reinjectContentScript(): Promise<void> {
  const tabsToInject = await chrome.tabs.query({
    url: ['https://*.atlassian.net/browse/*', 'https://*.atlassian.net/jira/*'],
  });
  for (const tab of tabsToInject) {
    if (!tab.id) continue;
    await injectIfMissing(tab.id);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[jfv:background] installed');
  void reinjectContentScript();
});

chrome.runtime.onStartup.addListener(() => {
  void reinjectContentScript();
});

// ponytail: on tab activation, inject if missing (handles session-restore scenario)
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isJiraUrl(tab.url)) {
      await injectIfMissing(tabId);
    }
  } catch {
    // Tab may have been closed, ignore
  }
});

// ponytail: on tab navigation complete, inject if missing
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isJiraUrl(tab.url)) {
    void injectIfMissing(tabId);
  }
});
