import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from 'puppeteer';
import { launchExtension, type ExtensionTestContext } from './setup';

const TEST_TIMEOUT = 30000;

describe('field visibility persistence across reload', () => {
  let ctx: ExtensionTestContext;
  let page: Page;

  beforeAll(async () => {
    ctx = await launchExtension();
    page = await ctx.browser.newPage();
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await ctx.teardown();
  });

  it(
    'a hidden field stays hidden after a fresh page load',
    async () => {
      const fixtureUrl = ctx.fixtureUrl('jira-issue-old-view.html');

      await page.goto(fixtureUrl, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Hide Story Points field"]');

      // Toggle "Story Points" off and wait for the visual change to apply.
      await page.click('[aria-label="Hide Story Points field"]');
      await page.waitForFunction(
        () => {
          const el = document.querySelector('#customfield_10001');
          const container = el ? el.closest('.field-row') : null;
          return !!container && getComputedStyle(container).display === 'none';
        },
        { timeout: 5000 }
      );

      // storage-service.toggleField is async (chrome.storage.sync.set) —
      // give the write time to land before reloading.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Fresh load: content-entry.ts's init() runs again from scratch.
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Show Story Points field"]');

      const storyPointsHiddenOnReload = await page.$eval(
        '#customfield_10001',
        (el) => getComputedStyle(el.closest('.field-row') as Element).display === 'none'
      );
      expect(storyPointsHiddenOnReload).toBe(true);

      // The toggle button itself should also reflect the persisted "hidden"
      // state (label flipped to "Show ...") rather than defaulting to shown.
      const toggleButton = await page.$('[aria-label="Show Story Points field"]');
      expect(toggleButton).not.toBeNull();
    },
    TEST_TIMEOUT
  );
});
