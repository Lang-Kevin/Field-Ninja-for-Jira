/**
 * issue-navigator.test.ts
 *
 * Regression test for the fix in 55c332c: getIssueRoot() scopes
 * `?selectedIssue=…` rendering to the issue-detail-panel container so the
 * field scan never leaks into sibling DOM. The issue navigator
 * (`/issues?selectedIssue=…`) has NO modal — the result list and the inline
 * detail view (issue-layout container) sit side by side in the same
 * document — so this exercises a different leak path than the board-modal
 * tests: without the issue-layout scope, listFields() would also pick up
 * the result list rows' own field-ish data-testids.
 *
 * Fixture: tests/fixtures/jira-issue-navigator-panel.html — a result list
 * (2 rows, each with an issue-field-* node) beside an
 * issue.views.issue-details.issue-layout.issue-layout detail view (Summary,
 * which is protected and gets no toggle, plus Description and Components,
 * which do).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchExtension, type ExtensionTestContext } from './setup';

describe('Issue navigator inline detail view scoping', () => {
  let ctx: ExtensionTestContext;

  beforeAll(async () => {
    ctx = await launchExtension();
  }, 30000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it(
    'only mounts .jfv-field-toggle for fields inside the issue-layout panel, never the result list rows',
    async () => {
      const page = await ctx.browser.newPage();
      try {
        // /issues path + ?selectedIssue= routes through the navigator's
        // inline detail view (issue-layout), not the board's modal — see
        // fixture-server.ts's '/issues' special-casing.
        const url = `${ctx.fixtureServer.url}/issues?fixture=jira-issue-navigator-panel.html&selectedIssue=DEV-1`;

        await page.goto(url, { waitUntil: 'networkidle0' });

        await page.waitForSelector('.jfv-field-toggle', { timeout: 5000 });

        const toggleCount = await page.$$eval(
          '.jfv-field-toggle',
          (buttons) => buttons.length
        );
        // Only the two non-protected fields inside issue-layout (Description,
        // Components) are toggle-able; Summary is protected (no toggle) and
        // the result list's Priority/Assignee fields must be excluded.
        expect(toggleCount).toBe(2);

        const togglesOutsideLayout = await page.$$eval(
          '.jfv-field-toggle',
          (buttons) =>
            buttons.filter(
              (b) =>
                !b.closest(
                  '[data-testid="issue.views.issue-details.issue-layout.issue-layout"]'
                )
            ).length
        );
        expect(togglesOutsideLayout).toBe(0);

        const listRowToggleCount = await page.$$eval(
          '[data-testid="issue-navigator-app.container"] .jfv-field-toggle',
          (buttons) => buttons.length
        );
        expect(listRowToggleCount).toBe(0);
      } finally {
        await page.close();
      }
    },
    14000
  );
});
