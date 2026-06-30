/**
 * board-late-panel-icons.test.ts
 *
 * Regression test for: field-toggle icons not appearing on a Jira board
 * "selectedIssue" detail panel when the modal renders AFTER the settle-poll
 * ceiling (10 × 300ms = 3 s in content-entry.ts L483-495).
 *
 * Scenario:
 *   - Cold board URL load with ?selectedIssue=DEV-119113 (no /browse/ in path
 *     so getIssueRoot() uses the modal-dialog selector, not document).
 *   - Board cards present in DOM from page load (leak-risk siblings).
 *   - [data-testid="issue.views.issue-details.issue-modal.modal-dialog"]
 *     containing one FIELD_SELECTOR-matching field is injected at 3500ms —
 *     past the settle ceiling.
 *   - No further DOM mutation occurs after the injection.
 *   - Assert that .jfv-field-toggle appears inside the modal within 6 s.
 *
 * Races under test:
 *   A) Settle poll caps at 3 s — cannot rescue a modal that renders later.
 *   B) watchIssueContext only fires on href change — cold-load URL never
 *      changes so it never fires; onIssuePage depends solely on init().
 *
 * Expected outcome if MutationObserver path works correctly: PASS (green).
 * Expected outcome if MutationObserver path is broken: FAIL (red — bug reproduced).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchExtension, type ExtensionTestContext } from './setup';

describe('Board late-panel icon mount', () => {
  let ctx: ExtensionTestContext;

  beforeAll(async () => {
    ctx = await launchExtension();
  }, 30000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it(
    'mounts .jfv-field-toggle inside the modal-dialog even when the modal renders after the 3s settle-poll ceiling',
    async () => {
      const page = await ctx.browser.newPage();

      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      try {
        // Path does NOT contain /browse/<KEY> so getIssueRoot() enters the
        // selectedIssue branch and waits for the modal-dialog selector.
        // The fixture server serves the HTML at this raw path (non-/browse/
        // requests use pathname directly as the fixture file to look up).
        const url =
          `${ctx.fixtureServer.url}/jira-board-late-panel.html?selectedIssue=DEV-119113`;

        await page.goto(url, { waitUntil: 'networkidle0' });

        // The settle poll exhausts at ~3 s, the modal appears at 3.5 s, and
        // the MutationObserver debounce adds another 300 ms — so icons should
        // be mounted at ~3.8 s from navigation start.  Allow up to 6 s total.
        const toggle = await page.waitForSelector(
          '[data-testid="issue.views.issue-details.issue-modal.modal-dialog"] .jfv-field-toggle',
          { timeout: 6000 },
        );

        expect(toggle).not.toBeNull();
      } finally {
        if (consoleErrors.length > 0) {
          console.log('Browser console errors captured:', consoleErrors);
        }
        await page.close();
      }
    },
    // 30 s: 6 s wait + up to 3.8 s for modal + 20 s slack for slow CI Chrome.
    // vitest.config.ts testTimeout = 15 000 ms; the per-test timeout below
    // is intentionally shorter so vitest's own timeout message is readable.
    14000,
  );
});
