/**
 * sprint-picker-flicker.test.ts
 *
 * Regression test for: clicking the Sprint field opens its picker dropdown,
 * but it flickers shut almost immediately, before a sprint can be selected.
 *
 * Root cause (see jira-issue-sprint-picker.html fixture): Jira's Sprint field
 * swaps its read-view for a brand-new, autofocused edit-view DOM node when
 * clicked — a node the content script has never seen before. The
 * MutationObserver-triggered rescan that follows used to treat that new node
 * as "just another field container" and immediately mount a toggle button
 * inside it, an unexpected DOM write that Jira's own picker treats as a
 * reason to close.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchExtension, type ExtensionTestContext } from './setup';

describe('Sprint picker stays open while focused', () => {
  let ctx: ExtensionTestContext;

  beforeAll(async () => {
    ctx = await launchExtension();
  }, 30000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it(
    'does not close the open Sprint edit-view after a debounced rescan',
    async () => {
      const page = await ctx.browser.newPage();
      try {
        await page.goto(ctx.fixtureUrl('jira-issue-sprint-picker.html'), {
          waitUntil: 'networkidle0',
        });
        await page.waitForSelector('.jfv-field-toggle');

        await page.click('#sprint-row');
        await page.waitForSelector('#sprint-edit-view');

        await page.type('#sprint-search', '13');

        // Let dom-observer's debounce (300ms) fire at least once.
        await new Promise((resolve) => setTimeout(resolve, 600));

        const stillOpen = await page.evaluate(
          () => document.getElementById('sprint-edit-view') !== null
        );
        const activeIsSearch = await page.evaluate(
          () => document.activeElement?.id === 'sprint-search'
        );

        expect(stillOpen).toBe(true);
        expect(activeIsSearch).toBe(true);
      } finally {
        await page.close();
      }
    },
    20000
  );
});
