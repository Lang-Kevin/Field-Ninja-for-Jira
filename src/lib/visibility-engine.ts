/**
 * visibility-engine.ts (Wave 3 / Milestone 4)
 *
 * Applies show/hide preferences to Jira field containers in the DOM. Always
 * targets `FieldMeta.containerNode` (the full row/section), never
 * `FieldMeta.node` (the inner value control) — hiding only the inner control
 * would leave an empty label/row behind.
 *
 * Two hiding mechanisms, layered:
 *  1. A stylesheet rule keyed on Jira's own stable data-testid/id attribute
 *     (computeHiddenSelectors + syncHiddenStylesheet) — the primary
 *     mechanism. Jira's field list is virtualized: scrolling destroys and
 *     recreates container nodes, which wipes any attribute *we* wrote on the
 *     old node. A rule keyed on Jira's own attribute still matches the
 *     freshly-created replacement node immediately, with no rescan latency.
 *  2. A `data-jfv-hidden` attribute + CSS rule (styles.css) — fallback for
 *     the rare field with no stable attribute to key off. Survives a plain
 *     inline-style race but not node recreation.
 *
 * Attribute writes are idempotent (only written when the desired value
 * differs from the current value) and wrapped in `markOwnMutation` so the
 * shared MutationObserver in dom-observer.ts doesn't re-observe our own
 * writes and loop. Batch attribute application is rAF-scheduled to avoid
 * layout thrash; the stylesheet write is synchronous (cheap, and speed is
 * the point).
 */

import { markOwnMutation } from './dom-observer';
import { JIRA_SELECTORS } from './jira-selectors';
import type { FieldMeta, TabMeta } from '../types/field-meta';

export interface VisibilityDiffEntry {
  field: FieldMeta;
  desiredHidden: boolean;
}

const HIDDEN_ATTR = 'data-jfv-hidden';

/**
 * Pure, no DOM writes, no I/O. Given the full field list and the set of
 * field ids that should be hidden, returns only the entries that actually
 * need a DOM write (idempotent diff) — i.e. entries whose `data-jfv-hidden`
 * attribute doesn't already match the desired state.
 *
 * Hiding is done via the `data-jfv-hidden` attribute + a `!important` CSS
 * rule (styles.css), not `containerNode.style.display` directly: Jira's own
 * scroll-driven re-renders also write inline style on the same container, an
 * inline-vs-inline race our debounced rescan can lose during continuous
 * scroll. A stylesheet `!important` rule beats Jira's plain inline writes
 * outright, so there's no race to lose. Protected fields (e.g. Summary,
 * Status) are always resolved to visible, even if their id is present in
 * hiddenFieldIds — this is the single enforcement point for "protected
 * fields are never hidden", since toggleField routes through this function.
 */
export function computeVisibilityDiff(
  fields: FieldMeta[],
  hiddenFieldIds: ReadonlySet<string> | string[]
): VisibilityDiffEntry[] {
  const hiddenSet =
    hiddenFieldIds instanceof Set ? hiddenFieldIds : new Set(hiddenFieldIds);

  const diff: VisibilityDiffEntry[] = [];

  for (const field of fields) {
    const desiredHidden = !field.protected && hiddenSet.has(field.id);
    const currentlyHidden = field.containerNode.getAttribute(HIDDEN_ATTR) === 'true';
    if (currentlyHidden !== desiredHidden) {
      diff.push({ field, desiredHidden });
    }
  }

  return diff;
}

/**
 * A tab whose panel contains at least one field, and every one of those
 * fields is hidden, should itself be hidden — an empty tab is worse than a
 * hidden one. A panel with zero recognized fields (e.g. a "Comments" tab
 * this extension doesn't scan) is left alone: `tabFields.length > 0` guards
 * against hiding tabs this extension simply has no fields for.
 */
export function computeHiddenTabs(
  tabs: TabMeta[],
  fields: FieldMeta[],
  hiddenFieldIds: ReadonlySet<string> | string[]
): TabMeta[] {
  const hiddenSet =
    hiddenFieldIds instanceof Set ? hiddenFieldIds : new Set(hiddenFieldIds);

  return tabs.filter((tab) => {
    const tabFields = fields.filter((field) =>
      tab.panelNode.contains(field.containerNode)
    );
    return (
      tabFields.length > 0 &&
      tabFields.every((field) => !field.protected && hiddenSet.has(field.id))
    );
  });
}

export function writeHiddenAttr(node: HTMLElement, hidden: boolean): void {
  if (hidden) {
    node.setAttribute(HIDDEN_ATTR, 'true');
  } else {
    node.removeAttribute(HIDDEN_ATTR);
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * Builds a CSS attribute selector from a Jira-owned identifying attribute
 * (data-testid, falling back to id) — NOT from anything this extension
 * writes. Jira's virtualized field list destroys and recreates container
 * nodes during scroll; a selector keyed on our own `data-jfv-hidden`
 * attribute is lost the instant a node is recreated. Jira re-renders the new
 * node with the identical data-testid/id though, so a stylesheet rule keyed
 * on that attribute matches the replacement node immediately — no rescan
 * latency, no flash. Returns null for nodes with neither attribute (rare
 * label-hash-only fields); those fall back to the data-jfv-hidden + CSS rule
 * in styles.css, which still closes the simpler inline-style race but can't
 * survive node recreation.
 */
function getStableSelector(node: HTMLElement): string | null {
  const testId = node.getAttribute('data-testid');
  if (testId) {
    return `[data-testid="${cssEscape(testId)}"]`;
  }
  const id = node.getAttribute('id');
  if (id) {
    return `#${cssEscape(id)}`;
  }
  return null;
}

/**
 * Computes the full set of stable CSS selectors for every field that should
 * currently be hidden — recomputed from scratch each call (fields +
 * hiddenFieldIds), never accumulated incrementally, so a field that
 * disappears from the page or from hiddenFieldIds can never leave a stale
 * rule behind.
 */
export function computeHiddenSelectors(
  fields: FieldMeta[],
  hiddenFieldIds: ReadonlySet<string> | string[]
): string[] {
  const hiddenSet =
    hiddenFieldIds instanceof Set ? hiddenFieldIds : new Set(hiddenFieldIds);
  const selectors: string[] = [];
  for (const field of fields) {
    if (field.protected || !hiddenSet.has(field.id)) {
      continue;
    }
    const selector = getStableSelector(field.containerNode);
    if (selector) {
      selectors.push(selector);
    }
  }
  return selectors;
}

/**
 * A section whose field list is non-empty and every field is hidden should
 * itself be hidden — mirrors computeHiddenTabs but for the collapsible section
 * wrappers ("Details", "Development") in Jira's sidebar.
 */
export function computeHiddenSections(
  sections: HTMLElement[],
  fields: FieldMeta[],
  hiddenFieldIds: ReadonlySet<string> | string[]
): HTMLElement[] {
  const hiddenSet =
    hiddenFieldIds instanceof Set ? hiddenFieldIds : new Set(hiddenFieldIds);

  return sections.filter((section) => {
    const sectionFields = fields.filter((field) =>
      section.contains(field.containerNode)
    );
    return (
      sectionFields.length > 0 &&
      sectionFields.every((field) => !field.protected && hiddenSet.has(field.id))
    );
  });
}

let styleEl: HTMLStyleElement | null = null;

/**
 * Writes the given selector list into a single shared `<style>` element in
 * `<head>` (outside document.body, so it's never seen by the shared
 * MutationObserver — no markOwnMutation needed). Idempotent: skips the write
 * if the computed text hasn't changed.
 */
export function syncHiddenStylesheet(selectors: string[]): void {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'jfv-hidden-style';
    document.head.appendChild(styleEl);
  }
  const text = selectors.length
    ? `${selectors.join(',\n')} {\n  display: none !important;\n}`
    : '';
  if (styleEl.textContent !== text) {
    styleEl.textContent = text;
  }
}

let coverStyleEl: HTMLStyleElement | null = null;

/**
 * Writes a cover-image height override into a single shared `<style>`
 * element in `<head>` (outside document.body — no markOwnMutation needed,
 * see syncHiddenStylesheet above). `null` clears the rule (Jira's original
 * cover height). Clamps to a sane range as the single validation point for
 * the popup's number input.
 *
 * ponytail: matches structurally, not by label text, so it survives all
 * ~25 Jira locales — `div[role="img"][aria-label]:empty` relies on the
 * cover being a `role="img"` div that (a) HAS an aria-label attribute
 * (present in every locale, just localized text) and (b) is empty.
 * Assignee avatars are also `role="img"` divs but carry no aria-label and
 * have child `<span>`s, so they're excluded on both counts. Only the
 * cover's direct parent is resized, not the grandparent: a `:has(> * > …)`
 * grandparent rule matches
 * whatever ancestor sits two levels up, which in the live issue header is
 * NOT a cover-only wrapper — it's the shared header container that also
 * holds the summary heading and field rows, so collapsing it took those
 * down too. If Jira ever wraps the cover one level deeper than
 * `wrapper > img`, this needs re-measuring against the live DOM rather than
 * widening the ancestor reach again.
 */
export function syncCoverStyle(heightPx: number | null): void {
  if (!coverStyleEl) {
    coverStyleEl = document.createElement('style');
    coverStyleEl.id = 'jfv-cover-style';
    document.head.appendChild(coverStyleEl);
  }
  const text =
    heightPx === null
      ? ''
      : (() => {
          const clamped = Math.min(600, Math.max(20, heightPx));
          return (
            `${JIRA_SELECTORS.cover} {\n  height: ${clamped}px !important;\n  min-height: 0 !important;\n  max-height: ${clamped}px !important;\n}\n` +
            `:has(> ${JIRA_SELECTORS.cover}) {\n  height: ${clamped}px !important;\n  min-height: 0 !important;\n  max-height: ${clamped}px !important;\n}`
          );
        })();
  if (coverStyleEl.textContent !== text) {
    coverStyleEl.textContent = text;
  }
}

/**
 * Applies a single field's visibility immediately (not batched/rAF) — the
 * direct response to a user clicking a toggle in the UI overlay. Still
 * idempotent and still wrapped in `markOwnMutation`. Does NOT persist to
 * storage itself — that's storage-service.toggleField's job, called
 * separately by whatever wires this up in Wave 5.
 */
export function toggleField(field: FieldMeta, hidden: boolean): void {
  const hiddenSet = hidden ? new Set([field.id]) : new Set<string>();
  const diff = computeVisibilityDiff([field], hiddenSet);

  if (diff.length === 0) {
    return;
  }

  markOwnMutation(() => {
    for (const entry of diff) {
      writeHiddenAttr(entry.field.containerNode, entry.desiredHidden);
    }
  });
}
