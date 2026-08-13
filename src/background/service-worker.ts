/**
 * Re-injects content script on service worker startup (session restore, memory saver unfreeze),
 * extension installation, tab activation, and tab completion. Also includes guard to skip
 * re-injection if already loaded in tab. Each tab in a non-injectable state is swallowed.
 */

import { isEligibleUrl } from '../lib/jira-context-resolver';
import { dropLegacyPrefs } from '../lib/storage-service';

// ponytail: colour icon is just the manifest's default_icon path.
function colourIcon(): { path: Record<number, string> } {
  return { path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png' } };
}

// ponytail: static pre-baked greyscale/dimmed icon (see scripts/make-grey-icons.cjs),
// no runtime canvas work — OffscreenCanvas is worker-only and unsupported on Firefox.
function greyIcon(): { path: Record<number, string> } {
  return { path: { 16: 'icons/icon16-grey.png', 48: 'icons/icon48-grey.png' } };
}

// ponytail: set the action icon for a tab based on URL eligibility; never throws.
async function setIconForTab(tabId: number, url: string | undefined): Promise<void> {
  try {
    const icon = isEligibleUrl(url) ? colourIcon() : greyIcon();
    await chrome.action.setIcon({ tabId, ...icon });
  } catch (e) {
    console.debug('[jfv:background] setIcon failed', e);
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
    url: [
      'https://*.atlassian.net/browse/*',
      'https://*.atlassian.net/jira/*',
      'https://*.atlassian.net/issues*',
    ],
  });
  for (const tab of tabsToInject) {
    if (!tab.id) continue;
    await injectIfMissing(tab.id);
    await setIconForTab(tab.id, tab.url);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[jfv:background] installed');
  await reinjectContentScript();
  await dropLegacyPrefs();
});

chrome.runtime.onStartup.addListener(() => {
  void reinjectContentScript();
});

// ponytail: on tab activation, inject if missing (handles session-restore scenario)
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isEligibleUrl(tab.url)) {
      await injectIfMissing(tabId);
    }
    await setIconForTab(tabId, tab.url);
  } catch {
    // Tab may have been closed, ignore
  }
});

// ponytail: on tab navigation complete, inject if missing
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isEligibleUrl(tab.url)) {
    void injectIfMissing(tabId);
  }
  // ponytail: icon also tracks changeInfo.url — an SPA navigation off an eligible URL never
  // reports status 'complete' and never re-runs the content script, so this is its only hook.
  if (changeInfo.status === 'complete' || changeInfo.url) {
    await setIconForTab(tabId, tab.url);
  }
});
