/**
 * Re-injects content script on service worker startup (session restore, memory saver unfreeze),
 * extension installation, tab activation, and tab completion. Also includes guard to skip
 * re-injection if already loaded in tab. Each tab in a non-injectable state is swallowed.
 */

import { isEligibleUrl } from '../lib/jira-context-resolver';
import { dropLegacyPrefs } from '../lib/storage-service';

// ponytail: colour icon is just the manifest's default_icon path, no source asset at 32px so
// icon48.png doubles as the fetch source for greyIcon() too (canvas draw scales it down).
function colourIcon(): { path: Record<number, string> } {
  return { path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png' } };
}

let cachedGreyIcon: { imageData: ImageData } | null = null;

// ponytail: build the greyscale icon once at runtime (no new asset file) and cache it.
async function greyIcon(): Promise<{ imageData: ImageData }> {
  if (cachedGreyIcon) return cachedGreyIcon;
  const response = await fetch(chrome.runtime.getURL('icons/icon48.png'));
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = luminance;
    data[i + 1] = luminance;
    data[i + 2] = luminance;
    data[i + 3] = data[i + 3] * 0.4;
  }
  cachedGreyIcon = { imageData };
  return cachedGreyIcon;
}

// ponytail: set the action icon for a tab based on URL eligibility; never throws.
async function setIconForTab(tabId: number, url: string | undefined): Promise<void> {
  try {
    const icon = isEligibleUrl(url) ? colourIcon() : await greyIcon();
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
    url: ['https://*.atlassian.net/browse/*', 'https://*.atlassian.net/jira/*'],
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
