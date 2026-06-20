import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from 'puppeteer';
import { launchExtension, type ExtensionTestContext } from './setup';

const TEST_TIMEOUT = 30000;

describe('per-issue-type field visibility isolation', () => {
  let ctx: ExtensionTestContext;
  let storyPage: Page;
  let epicPage: Page;

  beforeAll(async () => {
    ctx = await launchExtension();

    storyPage = await ctx.browser.newPage();
    await storyPage.goto(ctx.fixtureUrl('jira-issue-old-view.html'), {
      waitUntil: 'networkidle0',
    });
    await storyPage.waitForSelector('[aria-label="Hide Story Points field"]');

    epicPage = await ctx.browser.newPage();
    await epicPage.goto(ctx.fixtureUrl('jira-issue-epic.html'), {
      waitUntil: 'networkidle0',
    });
    // "Epic Name", not "Summary": Summary is a protected field (Wave 9) and
    // no longer gets a toggle button mounted at all.
    await epicPage.waitForSelector('[aria-label="Hide Epic Name field"]');
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await ctx.teardown();
  });

  it(
    'hiding a field on one issue type never affects another issue type',
    async () => {
      // Sanity: both fields start visible.
      const storyPointsVisibleBefore = await storyPage.$eval(
        '#customfield_10001',
        (el) => getComputedStyle(el.closest('.field-row') as Element).display !== 'none'
      );
      expect(storyPointsVisibleBefore).toBe(true);

      const epicNameVisibleBefore = await epicPage.$eval(
        '[data-testid="issue.fields.epicname-field"]',
        (el) => getComputedStyle(el.closest('.field-row') as Element).display !== 'none'
      );
      expect(epicNameVisibleBefore).toBe(true);

      // Hide "Story Points" on the Story page only.
      await storyPage.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[aria-label="Hide Story Points field"]'
        );
        button?.click();
      });

      await storyPage.waitForFunction(
        () => {
          const el = document.querySelector('#customfield_10001');
          const container = el ? el.closest('.field-row') : null;
          return !!container && getComputedStyle(container).display === 'none';
        },
        { timeout: 5000 }
      );

      const storyPointsHiddenAfter = await storyPage.$eval(
        '#customfield_10001',
        (el) => getComputedStyle(el.closest('.field-row') as Element).display === 'none'
      );
      expect(storyPointsHiddenAfter).toBe(true);

      // Give the async storage write a moment to land, then confirm the
      // Epic page's Epic Name field is completely unaffected.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const epicNameVisibleAfter = await epicPage.$eval(
        '[data-testid="issue.fields.epicname-field"]',
        (el) => getComputedStyle(el.closest('.field-row') as Element).display !== 'none'
      );
      expect(epicNameVisibleAfter).toBe(true);

      const epicNameToggleStillSaysHide = await epicPage.$(
        '[aria-label="Hide Epic Name field"]'
      );
      expect(epicNameToggleStillSaysHide).not.toBeNull();
    },
    TEST_TIMEOUT
  );
});
