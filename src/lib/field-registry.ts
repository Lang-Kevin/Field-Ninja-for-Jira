/**
 * field-registry.ts (Wave 2)
 *
 * Scans the Jira issue page DOM for field elements and maps them to
 * FieldMeta objects, deriving stable ids via deriveFieldId.
 *
 * The real Jira DOM structure isn't confirmed yet (no live fixture), so the
 * selectors used here are provisional best guesses. They are hardened with
 * real Jira fixtures in Wave 5/7 — see docs/PLAN.md Edge-case-A.
 */

import type { FieldMeta, TabMeta } from '../types/field-meta';
import { deriveFieldId, normalizeLabel } from './field-id';

/**
 * Provisional selector for a "field container" marker element — the
 * enclosing row/section that should be hidden, per the project's hard rule
 * "hide at the container level, never just the inner value node."
 * Hardened in Wave 5/7 with real Jira fixtures.
 *
 * Wave 9 tried removing the bare `[role="group"]` token as a hypothesis fix
 * for "Release Notes (deutsch) can't be hidden in a tab" (suspected cause:
 * `[role="group"]` matching too broadly on real Jira tab/section wrappers,
 * collapsing multiple distinct fields onto one shared container). That
 * change was reverted: it broke `findContainer`'s fallback for fields whose
 * *only* container marker is `role="group"` (e.g. `tests/fixtures/
 * jira-issue-old-view.html`'s `.field-row[role="group"]` rows, asserted on
 * directly by `tests/integration/persistence-reload.test.ts`) — those fields
 * lost their row wrapper as containerNode entirely and fell back to hiding
 * just the value node. The role=group token must stay until bug 5 has a real
 * Jira repro to design a narrower fix against; see docs/PLAN.md.
 */
const CONTAINER_MARKER_SELECTOR =
  '[data-testid*="field"], [data-testid*="-field"], [id^="customfield_"], [class*="customfield"], [role="group"]';

/**
 * Provisional selector for plausible field elements on a Jira issue page.
 * Covers new-view (`data-testid`) and old-view (`customfield_*` id/class
 * conventions) selector patterns. Hardened in Wave 5/7 with real Jira
 * fixtures.
 */
const FIELD_SELECTOR =
  '[data-testid*="field"], [data-testid*="-field"], [id^="customfield_"], [class*="customfield"]';

/**
 * Selector for a field's heading element on Jira's empty-field markup. When
 * a field has no value, Jira renders ONLY this heading (no `data-testid`,
 * `id`, or `customfield` class anywhere in the block) — so FIELD_SELECTOR
 * alone misses it. See findHeadingOnlyCandidates.
 *
 * Provisional: `[data-component-selector*="field-heading"]` is asserted only
 * against the single real DOM snippet a user reported for one field
 * ("Release Notes (deutsch)"), not yet corroborated against other empty-field
 * types. Hardened once more real Jira markup is confirmed.
 */
const FIELD_HEADING_SELECTOR = '[data-component-selector*="field-heading"]';

/**
 * Provisional selector for sidebar app panels (e.g. Automation, Tempo) that
 * aren't matched by FIELD_SELECTOR because they're not Jira's own native
 * fields but third-party app panels rendered into the issue view. Hardened
 * once real Jira markup for these panels is confirmed.
 */
const PANEL_SELECTOR = '[data-testid*="panel"], [data-testid*="-panel"]';

/**
 * Jira's own global app-shell navigation rail (aria-label="Sidebar" in real
 * Jira) sits outside the issue view but its descendants can still
 * substring-match FIELD_SELECTOR/PANEL_SELECTOR (e.g. nav data-testids
 * containing "panel"). Any candidate whose closest ancestor matches this is
 * page chrome, never an issue field — excluded outright rather than merely
 * marked protected, since protected still shows the row in the panel list.
 */
const GLOBAL_NAV_EXCLUDE_SELECTOR = '[aria-label="Sidebar"]';

/**
 * Provisional selector for a label element near a field. Hardened in
 * Wave 5/7 with real Jira fixtures.
 */
const LABEL_SELECTOR = 'label, [data-testid*="label"]';

/**
 * Normalized labels of fields that must never be user-hideable. Matched via
 * normalizeLabel so case/whitespace differences don't cause a miss.
 */
const PROTECTED_LABELS = new Set(['summary', 'status']);

/**
 * Testid substrings of known Jira-native wrappers for protected fields that
 * have no nearby <label> sibling, so deriveLabel falls back to raw text
 * instead of "Summary"/"Status" — dodging the PROTECTED_LABELS check and
 * letting a toggle button get mounted inside Jira's own container. Catch
 * them by testid instead, since that's stable regardless of issue content.
 * - "issue-field-summary": Summary's read-only value container.
 * - "ref-spotlight-target-status-spotlight": Status's onboarding-tour
 *   spotlight wrapper.
 */
const PROTECTED_TESTID_SUBSTRINGS = ['issue-field-summary', 'ref-spotlight-target-status-spotlight'];

/**
 * `closest()` selector built from PROTECTED_TESTID_SUBSTRINGS. Unlike
 * CONTAINER_MARKER_SELECTOR's generic "field" substring (deliberately kept
 * bounded — see findContainer), this is a short whitelist of known-stable
 * Jira wrapper testids, so an unbounded ancestor walk is safe: a containerNode
 * resolved to some *descendant* of one of these wrappers (not just the
 * wrapper itself) still ends up with our button rendered inside it.
 */
const PROTECTED_TESTID_SELECTOR = PROTECTED_TESTID_SUBSTRINGS.map(
  (s) => `[data-testid*="${s}"]`
).join(', ');

/** Max levels to walk up via parentElement when searching for a container. */
const MAX_CONTAINER_WALK = 6;

/**
 * Walk up from a given field value-node to find its enclosing "field
 * container" (the full row/section that should be hidden). Checks each
 * ancestor explicitly (`matches()`, not `closest()`) up to
 * MAX_CONTAINER_WALK levels — `closest()` searches the WHOLE unbounded
 * ancestor chain, so it could latch onto an unrelated marker far up the
 * tree (e.g. a `role="group"` tab/section wrapper), wrongly treating it as
 * this field's container. Falls back to the immediate parentElement, or the
 * node itself if it has no parent (never returns null/undefined).
 */
export function findContainer(node: Element): Element {
  let current: Element | null = node.parentElement;
  for (let i = 0; i < MAX_CONTAINER_WALK && current; i++) {
    try {
      if (current.matches(CONTAINER_MARKER_SELECTOR)) {
        return current;
      }
    } catch {
      // Defensively ignore selector errors and keep walking.
    }
    current = current.parentElement;
  }
  // No ancestor matched a container marker. Prefer the field's own node if
  // it itself matches the marker selector (e.g. its data-testid contains
  // "field") over the anonymous parentElement fallback: anonymous wrapper
  // divs can be discarded/replaced by React across re-renders, silently
  // wiping any style.display write or mounted toggle button, whereas the
  // field's own marker-matching node is stable across renders.
  try {
    if (node.matches(CONTAINER_MARKER_SELECTOR)) {
      // The node's own testid can substring-match the marker (e.g.
      // "issue.views.field.rich-text.customfield_12042" contains "field")
      // even though it's only the value half of a label+value pair living
      // in an unmarked wrapper div. If its parent also holds a label
      // sibling, the parent is the real row to hide — use it instead.
      const parent = node.parentElement;
      if (parent && parent.querySelector(LABEL_SELECTOR)) {
        return parent;
      }
      return node;
    }
  } catch {
    // Defensively ignore selector errors and fall through to the parent.
  }
  return node.parentElement ?? node;
}

/**
 * Derive a human-readable label for a field element. Tries, in order:
 * 1. The element's own aria-label.
 * 2. A sibling/child label element via LABEL_SELECTOR within the element's
 *    parent (a "reasonable ancestor scope").
 * 3. The element's own trimmed text content, truncated to 60 chars.
 * 4. 'unknown field' as a last resort.
 */
function deriveLabel(el: Element): string {
  try {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim().length > 0) {
      return ariaLabel.trim();
    }
  } catch {
    // ignore and fall through
  }

  try {
    const scope = el.parentElement ?? el;
    const labelEl = scope.querySelector(LABEL_SELECTOR);
    const labelText = labelEl?.textContent?.trim();
    if (labelText && labelText.length > 0) {
      return labelText;
    }
  } catch {
    // ignore and fall through
  }

  try {
    // Exclude our own injected toggle button: findContainer can resolve
    // containerNode to this same node (e.g. real Jira's customfield value
    // div has no aria-label), and mountFieldToggle appends the toggle
    // button as its child — so a later re-scan would otherwise read the
    // button's own glyph text back into the label.
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('.jfv-field-toggle').forEach((n) => n.remove());
    const text = (clone.textContent ?? '').trim().slice(0, 60);
    if (text.length > 0) {
      return text;
    }
  } catch {
    // ignore and fall through
  }

  return 'unknown field';
}

/**
 * Find a container for a heading-only field candidate (see
 * findHeadingOnlyCandidates) that encloses both the heading AND its value.
 *
 * findContainer() stops at the first ancestor matching
 * CONTAINER_MARKER_SELECTOR, which for some real Jira fields (e.g. "Release
 * Notes (deutsch)") is a narrow title-row wrapper around the heading alone —
 * the value renders as an unmarked sibling block one or more levels further
 * up, outside that wrapper. Using the narrow wrapper as containerNode hides
 * only the heading and leaves the value visible (the user-reported bug).
 * Instead, walk up until textContent grows past the heading's own text,
 * i.e. the first ancestor that actually encloses more than just the heading.
 */
function findHeadingContainer(heading: Element): Element {
  const headingText = heading.textContent?.trim() ?? '';
  let current: Element | null = heading.parentElement;
  for (let i = 0; i < MAX_CONTAINER_WALK && current; i++) {
    const text = current.textContent?.trim() ?? '';
    if (text.length > headingText.length) {
      return current;
    }
    current = current.parentElement;
  }
  // No ancestor within the walk limit has more text than the heading itself
  // — a genuinely empty field with no value anywhere nearby. Fall back to
  // the heading's immediate wrapper rather than climbing further (avoids
  // ever returning <html>/<body> when nothing distinguishes one ancestor
  // from the next).
  return heading.parentElement ?? heading;
}

/**
 * Find field-heading elements (FIELD_HEADING_SELECTOR) that represent an
 * EMPTY field — i.e. no FIELD_SELECTOR match exists anywhere nearby. Walks
 * up from each heading via parentElement, up to MAX_CONTAINER_WALK levels,
 * checking `ancestor.querySelector(FIELD_SELECTOR)` at each level. If a
 * FIELD_SELECTOR match is found at any level, the heading belongs to a
 * FILLED field already covered by the main FIELD_SELECTOR scan in
 * listFields, so it's skipped here to avoid double-registering. If nothing
 * is found after the full walk, the heading itself is treated as the field
 * candidate (there's no separate value node to find for an empty field).
 */
function findHeadingOnlyCandidates(scope: ParentNode): Element[] {
  let headings: Element[] = [];
  try {
    headings = Array.from(scope.querySelectorAll(FIELD_HEADING_SELECTOR));
  } catch {
    return [];
  }

  const result: Element[] = [];
  for (const heading of headings) {
    try {
      let current: Element | null = heading.parentElement;
      let foundFilled = false;
      for (let i = 0; i < MAX_CONTAINER_WALK && current; i++) {
        if (current.querySelector(FIELD_SELECTOR)) {
          foundFilled = true;
          break;
        }
        current = current.parentElement;
      }
      if (!foundFilled) {
        result.push(heading);
      }
    } catch {
      continue;
    }
  }
  return result;
}

/**
 * Query `root` (defaults to `document`) for plausible field elements and
 * map each to a FieldMeta. Defensively skips (continues past) any element
 * that errors during processing. De-duplicates by id (last-wins) using a
 * Map.
 */
export function listFields(root?: ParentNode): FieldMeta[] {
  const scope = root ?? document;
  const byId = new Map<string, FieldMeta>();

  let candidates: Element[] = [];
  try {
    candidates = Array.from(scope.querySelectorAll(FIELD_SELECTOR));
  } catch {
    return [];
  }
  const headingOnlyCandidates = findHeadingOnlyCandidates(scope);
  const headingOnlySet = new Set(headingOnlyCandidates);
  candidates = candidates.concat(headingOnlyCandidates);

  // Real Jira nests multiple field-matching elements (wrapper/inline-edit/
  // read-view) for the same logical field. querySelectorAll returns matches
  // in document order, so an ancestor is always kept before its descendants
  // are checked — a forward-only containment check collapses nested
  // duplicates while leaving genuinely separate (sibling) candidates intact.
  // <label> elements are excluded: they're looked up via LABEL_SELECTOR for
  // deriveLabel, never treated as a field in their own right.
  const kept: Element[] = [];
  for (const el of candidates) {
    if (el.tagName === 'LABEL') {
      continue;
    }
    if (kept.some((k) => k.contains(el))) {
      continue;
    }
    kept.push(el);
  }

  for (const el of kept) {
    try {
      if (!(el instanceof HTMLElement)) {
        continue;
      }
      if (el.closest(GLOBAL_NAV_EXCLUDE_SELECTOR)) {
        continue;
      }
      const label = deriveLabel(el);
      const containerNode = headingOnlySet.has(el) ? findHeadingContainer(el) : findContainer(el);
      if (!(containerNode instanceof HTMLElement)) {
        continue;
      }
      const id = deriveFieldId(el, label);

      const meta: FieldMeta = {
        id,
        label,
        node: el,
        containerNode,
        protected:
          PROTECTED_LABELS.has(normalizeLabel(label)) ||
          !!containerNode.closest(PROTECTED_TESTID_SELECTOR) ||
          !!el.closest(PROTECTED_TESTID_SELECTOR),
      };
      byId.set(id, meta);
    } catch {
      continue;
    }
  }

  return Array.from(byId.values());
}

/**
 * Query `root` (defaults to `document`) for tab buttons (e.g. "Key Details")
 * using the standard ARIA tabs pattern: `role="tab"` paired with its panel
 * via `aria-controls` -> matching element id. Provisional like the rest of
 * this file's selectors — not yet confirmed against real Jira markup.
 */
export function listTabs(root?: ParentNode): TabMeta[] {
  const scope = root ?? document;
  const tabs: TabMeta[] = [];

  let candidates: Element[] = [];
  try {
    candidates = Array.from(scope.querySelectorAll('[role="tab"]'));
  } catch {
    return [];
  }

  for (const tabNode of candidates) {
    try {
      if (!(tabNode instanceof HTMLElement)) {
        continue;
      }
      const panelId = tabNode.getAttribute('aria-controls');
      const panelNode = panelId ? document.getElementById(panelId) : null;
      if (panelNode instanceof HTMLElement) {
        tabs.push({ tabNode, panelNode });
      }
    } catch {
      continue;
    }
  }

  return tabs;
}

/**
 * Query `root` (defaults to `document`) for plausible sidebar app panels
 * (e.g. Automation, Tempo) and map each to a FieldMeta. Unlike listFields,
 * a panel acts as both its own node and its own container — there's no
 * separate "value node" vs. "row wrapper" distinction for these. Defensively
 * skips (continues past) any element that errors during processing.
 * De-duplicates by id (last-wins) using a Map.
 */
export function listPanels(root?: ParentNode): FieldMeta[] {
  const scope = root ?? document;
  const byId = new Map<string, FieldMeta>();

  let candidates: Element[] = [];
  try {
    candidates = Array.from(scope.querySelectorAll(PANEL_SELECTOR));
  } catch {
    return [];
  }

  for (const el of candidates) {
    try {
      if (!(el instanceof HTMLElement)) {
        continue;
      }
      if (el.closest(GLOBAL_NAV_EXCLUDE_SELECTOR)) {
        continue;
      }
      const label = deriveLabel(el);
      const id = deriveFieldId(el, label);

      const meta: FieldMeta = {
        id,
        label,
        node: el,
        containerNode: el,
        protected: PROTECTED_LABELS.has(normalizeLabel(label)),
      };
      byId.set(id, meta);
    } catch {
      continue;
    }
  }

  return Array.from(byId.values());
}
