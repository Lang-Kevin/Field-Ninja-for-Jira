import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from 'puppeteer';
import { launchExtension, type ExtensionTestContext } from './setup';

const TEST_TIMEOUT = 30000;

const PREFS_STORAGE_KEY = 'jiraFieldVisibility:v3';

describe('options page groups prefs by site and project', () => {
  let ctx: ExtensionTestContext;
  let page: Page;

  beforeAll(async () => {
    ctx = await launchExtension();

    page = await ctx.browser.newPage();
    await page.goto(`chrome-extension://${ctx.extensionId}/options.html`);

    // Seed two scopes across two different hosts/projects directly in
    // storage, then reload so options.ts's init() re-renders from scratch.
    await page.evaluate(
      (key) => {
        return chrome.storage.sync.set({
          [key]: {
            'acme.atlassian.net:CSM:story': {
              host: 'acme.atlassian.net',
              projectKey: 'CSM',
              issueTypeId: 'story',
              hiddenFieldIds: ['field1'],
            },
            'other.atlassian.net:DEV:bug': {
              host: 'other.atlassian.net',
              projectKey: 'DEV',
              issueTypeId: 'bug',
              hiddenFieldIds: ['field2'],
            },
          },
        });
      },
      PREFS_STORAGE_KEY
    );

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => document.querySelectorAll('.jfv-project-group').length >= 2,
      { timeout: 5000 }
    );
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await ctx.teardown();
  });

  it(
    'renders a separate group per host+project scope',
    async () => {
      // ponytail: setup.ts seeds three localhost activation-only scopes
      // (no prefs) so real content-entry gating runs in other integration
      // tests — options.ts renders those groups too. Assert our two seeded
      // pref scopes exist rather than the total group count.
      const headings = await page.$$eval('.jfv-project-heading', (els) =>
        els.map((el) => el.textContent?.trim())
      );

      expect(headings.some((h) => h?.startsWith('acme.atlassian.net — CSM'))).toBe(true);
      expect(headings.some((h) => h?.startsWith('other.atlassian.net — DEV'))).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "keeps each scope group's pref rows isolated from the other scope",
    async () => {
      const groups = await page.$$('.jfv-project-group');

      for (const group of groups) {
        const heading = await group.$eval('.jfv-project-heading', (el) => el.textContent ?? '');
        const rows = await group.$$('.jfv-pref-row');

        if (heading.startsWith('acme.atlassian.net — CSM')) {
          expect(rows.length).toBe(1);
        } else if (heading.startsWith('other.atlassian.net — DEV')) {
          expect(rows.length).toBe(1);
        } else {
          // Activation-only seeded scopes from setup.ts have no pref rows.
          expect(rows.length).toBe(0);
        }
      }
    },
    TEST_TIMEOUT
  );
});
