/**
 * rapid-toggling.test.ts (Integration-B)
 *
 * Exercises dom-observer.ts's debounced re-render path under rapid,
 * back-to-back toggle clicks (no waiting between clicks within a single
 * field) to confirm markOwnMutation suppression + the 300ms debounce settle
 * to a consistent final state with no race condition: each field's
 * container display state must agree with its own toggle button's
 * aria-label state after the dust settles.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchExtension, type ExtensionTestContext } from './setup';

/** Clicks a field's toggle button `times` times in immediate succession. */
async function clickRapid(
  page: import('puppeteer').Page,
  ariaLabelSubstring: string,
  times: number
): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.evaluate((substr: string) => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.jfv-field-toggle')
      );
      const button = buttons.find((b) =>
        (b.getAttribute('aria-label') ?? '').includes(substr)
      );
      button?.click();
    }, ariaLabelSubstring);
  }
}

describe('Rapid toggling (debounce + suppression consistency)', () => {
  let ctx: ExtensionTestContext;

  beforeAll(async () => {
    ctx = await launchExtension();
  }, 30000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it(
    'settles to a consistent final visible/hidden state after rapid clicks on multiple fields',
    async () => {
      const page = await ctx.browser.newPage();
      try {
        await page.goto(ctx.fixtureUrl('jira-issue-old-view.html'), {
          waitUntil: 'networkidle0',
        });
        await page.waitForSelector('.jfv-field-toggle');

        // Two distinct fields present in jira-issue-old-view.html.
        const fieldA = 'Story Points'; // odd number of clicks -> ends hidden
        const fieldB = 'Sprint'; // even number of clicks -> ends visible

        await clickRapid(page, fieldA, 3);
        await clickRapid(page, fieldB, 4);

        // Let dom-observer's debounce (300ms) + any pending re-renders flush.
        await new Promise((resolve) => setTimeout(resolve, 800));

        const state = await page.evaluate(
          (labelA: string, labelB: string) => {
            function readState(substr: string) {
              const buttons = Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                  '.jfv-field-toggle'
                )
              );
              const button = buttons.find((b) =>
                (b.getAttribute('aria-label') ?? '').includes(substr)
              );
              if (!button) {
                return null;
              }
              const ariaLabel = button.getAttribute('aria-label') ?? '';
              // mountFieldToggle's labels are "Hide X field" / "Show X field".
              const buttonSaysHidden = ariaLabel.startsWith('Show');

              const container = button.closest(
                '.field-row'
              ) as HTMLElement | null;
              // getComputedStyle, not container.style.display: hiding is done
              // via a data-jfv-hidden attribute + CSS rule (and/or a stable
              // data-testid/id stylesheet selector), never an inline style
              // write — see visibility-engine.ts.
              const containerHidden = container
                ? getComputedStyle(container).display === 'none'
                : null;

              return { buttonSaysHidden, containerHidden, ariaLabel };
            }

            return {
              a: readState(labelA),
              b: readState(labelB),
            };
          },
          fieldA,
          fieldB
        );

        expect(state.a).not.toBeNull();
        expect(state.b).not.toBeNull();

        // 3 clicks (odd) -> ends hidden.
        expect(state.a?.buttonSaysHidden).toBe(true);
        expect(state.a?.containerHidden).toBe(true);

        // 4 clicks (even) -> ends visible.
        expect(state.b?.buttonSaysHidden).toBe(false);
        expect(state.b?.containerHidden).toBe(false);

        // No inconsistency between the toggle button's own state and its
        // field container's actual display state.
        expect(state.a?.buttonSaysHidden).toBe(state.a?.containerHidden);
        expect(state.b?.buttonSaysHidden).toBe(state.b?.containerHidden);
      } finally {
        await page.close();
      }
    },
    20000
  );
});
