/**
 * sprint-picker-portal-flicker.test.ts
 *
 * Regression test for: clicking the Sprint field opens a portal-rendered
 * dropdown that is a sibling of the form (child of document.body), not
 * nested inside the field row.
 *
 * Root cause (see jira-issue-sprint-picker-portal.html fixture): Jira's
 * Sprint field swaps its read-view for an autofocused inline search input,
 * and renders the actual dropdown options via React portal as a child of
 * document.body. The portal div itself has a data-testid matching FIELD_SELECTOR,
 * so field-registry.ts treats it as a separate "field" with its own containerNode.
 *
 * The focused input is NOT inside the portal container, so the old fix
 * (checking field.containerNode.contains(document.activeElement) per-field)
 * would fail to detect that the portal is "the open editor" and would mount
 * a toggle button inside it.
 *
 * The new global userIsEditing check (detecting that activeElement is an
 * INPUT/TEXTAREA/contentEditable element) prevents this by suppressing toggle
 * button mounting whenever the user is actively editing, regardless of DOM
 * ancestry relationships.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchExtension, type ExtensionTestContext } from './setup';

describe('Sprint picker portal stays open while focused', () => {
  let ctx: ExtensionTestContext;

  beforeAll(async () => {
    ctx = await launchExtension();
  }, 30000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it(
    'does not close the portal dropdown after a debounced rescan',
    async () => {
      const page = await ctx.browser.newPage();
      try {
        await page.goto(ctx.fixtureUrl('jira-issue-sprint-picker-portal.html'), {
          waitUntil: 'networkidle0',
        });
        await page.waitForSelector('.jfv-field-toggle');

        await page.click('#sprint-row');
        await page.waitForSelector('#sprint-edit-view');

        // Portal should now be visible as a child of body.
        const portalExists = await page.evaluate(
          () => document.getElementById('sprint-portal-options') !== null
        );
        expect(portalExists).toBe(true);

        // Verify portal was created with its data-testid before typing.
        const portalHasMarker = await page.evaluate(
          () => {
            const portal = document.getElementById('sprint-portal-options');
            return portal?.getAttribute('data-testid') === 'issue.fields.sprint-field--options';
          }
        );
        expect(portalHasMarker).toBe(true);

        await page.type('#sprint-search', '13');

        // Let dom-observer's debounce (300ms) fire at least once.
        await new Promise((resolve) => setTimeout(resolve, 600));

        // Portal should still be open and in the DOM.
        const portalStillOpen = await page.evaluate(
          () => document.getElementById('sprint-portal-options') !== null
        );
        const portalStillHasMarker = await page.evaluate(
          () => {
            const portal = document.getElementById('sprint-portal-options');
            return portal?.getAttribute('data-testid') === 'issue.fields.sprint-field--options';
          }
        );
        const activeIsSearch = await page.evaluate(
          () => document.activeElement?.id === 'sprint-search'
        );

        expect(portalStillOpen).toBe(true);
        expect(portalStillHasMarker).toBe(true);
        expect(activeIsSearch).toBe(true);
      } finally {
        await page.close();
      }
    },
    20000
  );
});
