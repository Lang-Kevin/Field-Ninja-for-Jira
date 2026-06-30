/**
 * board-late-testid.test.ts
 *
 * STEP 1 confirmation test for the late-testid bug hypothesis:
 *
 *   The MutationObserver (src/lib/dom-observer.ts) uses
 *   attributeFilter: ['style','class'], so when Jira attaches the issue modal
 *   node first (childList mutation → observer fires, but getIssueRoot() finds
 *   no selector match → 0 fields) and then sets the identifying
 *   data-testid="issue.views.issue-details.issue-modal.modal-dialog" in a
 *   LATER attribute mutation, the observer never re-fires. If the board goes
 *   idle and the settle poll has already hit its 3s cap, icons never mount.
 *
 * Scenario:
 *   - Board URL with ?selectedIssue=DEV-119113 (no /browse/ path →
 *     getIssueRoot() uses the modal-dialog selector branch).
 *   - Board cards present in DOM from page load.
 *   - At 3500ms: modal node appended with data-testid="some-other-modal"
 *     (wrong testid) but containing real field markup.
 *   - At 4200ms: setAttribute('data-testid',
 *     'issue.views.issue-details.issue-modal.modal-dialog') on that node.
 *     No further DOM mutation after this.
 *   - Assert .jfv-field-toggle appears inside the modal within 8s.
 *
 * Regression guard for the late-data-testid race. Failed (red) against the
 * old 3s settle-poll cap (settleAttempts >= 10); passes now that the cap is
 * ~30s (>= 100), so the poll re-resolves getIssueRoot() once the real testid
 * is set. Revert the content-entry.ts cap to 10 to see this go red again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchExtension, type ExtensionTestContext } from './setup';

describe('Board late-testid icon mount (STEP 1 bug confirmation)', () => {
  let ctx: ExtensionTestContext;

  beforeAll(async () => {
    ctx = await launchExtension();
  }, 30000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it(
    'mounts .jfv-field-toggle inside the modal when the identifying data-testid is set AFTER the node is attached (no further DOM mutation)',
    async () => {
      const page = await ctx.browser.newPage();

      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      try {
        // Non-/browse/ path → getIssueRoot() takes the selectedIssue/modal branch.
        const url =
          `${ctx.fixtureServer.url}/jira-board-late-testid.html?selectedIssue=DEV-119113`;

        await page.goto(url, { waitUntil: 'networkidle0' });

        // Timeline:
        //   3500ms  modal appended with wrong testid → childList mutation fires
        //           observer, but getIssueRoot() returns empty fragment → 0 fields
        //   4200ms  setAttribute sets correct testid → data-testid NOT in
        //           attributeFilter → observer silent → settle poll already stopped
        //   8000ms  timeout if icons never appear
        const toggle = await page.waitForSelector(
          '[data-testid="issue.views.issue-details.issue-modal.modal-dialog"] .jfv-field-toggle',
          { timeout: 8000 },
        );

        expect(toggle).not.toBeNull();
      } finally {
        if (consoleErrors.length > 0) {
          console.log('Browser console errors captured:', consoleErrors);
        }
        await page.close();
      }
    },
    14000,
  );
});
