/**
 * spa-navigation.test.ts (Integration-B)
 *
 * Verifies that jira-context-resolver.ts's `watchIssueContext` detects a
 * client-side (pushState-driven) navigation to a different issue type and
 * that content-entry.ts's `init()` wiring re-renders the field toggles for
 * the new field set. No fixture ships its own pushState JS, so the
 * transition is driven from the test via `page.evaluate()`: change the URL,
 * mutate the issue-type badge's aria-label/data-testid, and swap in the new
 * issue type's field markup — then wait past the resolver's 300ms poll
 * debounce and assert the toggle buttons reflect the new fields.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchExtension, type ExtensionTestContext } from './setup';

describe('SPA navigation (watchIssueContext + re-render)', () => {
  let ctx: ExtensionTestContext;

  beforeAll(async () => {
    ctx = await launchExtension();
  }, 30000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it(
    'detects an in-page issue-type change and re-renders toggles for the new field set',
    async () => {
      const page = await ctx.browser.newPage();
      try {
        await page.goto(ctx.fixtureUrl('jira-issue-old-view.html'), {
          waitUntil: 'networkidle0',
        });

        // Sanity check: initial render reflects the Story fixture's fields.
        await page.waitForSelector('.jfv-field-toggle');
        const initialLabels = await page.$$eval('.jfv-field-toggle', (buttons) =>
          buttons.map((b) => b.getAttribute('aria-label') ?? '')
        );
        expect(initialLabels.some((l) => l.includes('Story Points'))).toBe(true);

        const epicFixtureUrl = ctx.fixtureUrl('jira-issue-epic.html');

        // Simulate an SPA transition: change the URL via pushState (the
        // resolver's poll compares location.href), update the issue-type
        // badge in place to read "Epic", and replace the old-view fields
        // container's contents with the epic fixture's field markup.
        await page.evaluate(async (epicUrl: string) => {
          history.pushState({}, '', '/browse/EPIC-303');

          const badge = document.querySelector(
            '[data-testid="issue-type-icon"]'
          );
          if (badge) {
            badge.setAttribute('aria-label', 'Epic');
            badge.setAttribute('title', 'Epic');
          }

          const html = await fetch(epicUrl).then((r) => r.text());
          const parsed = new DOMParser().parseFromString(html, 'text/html');
          const epicFields = parsed.querySelector('#epic-fields');
          const oldViewFields = document.querySelector('#old-view-fields');
          if (epicFields && oldViewFields) {
            oldViewFields.innerHTML = epicFields.innerHTML;
          }
        }, epicFixtureUrl);

        // watchIssueContext polls every 300ms (debounced); wait past that.
        await new Promise((resolve) => setTimeout(resolve, 800));

        const updatedLabels = await page.$$eval('.jfv-field-toggle', (buttons) =>
          buttons.map((b) => b.getAttribute('aria-label') ?? '')
        );

        expect(
          updatedLabels.some(
            (l) => l.includes('Epic Name') || l.includes('Summary')
          )
        ).toBe(true);
        expect(updatedLabels.some((l) => l.includes('Story Points'))).toBe(
          false
        );
      } finally {
        await page.close();
      }
    },
    20000
  );
});
