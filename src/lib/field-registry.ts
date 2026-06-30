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
 * Jira's "Child work items" panel — renders child issue rows in a table.
 * Its heading/chrome elements have testids containing "child-issues-panel"
 * and substring-match PANEL_SELECTOR, but they are Jira's own rendering
 * chrome, not user-toggleable fields. The data grid region is excluded via
 * its aria-label. Both checks are done via closest() so nested elements
 * (e.g. priority/status readviews rendered per child-issue row) are also
 * caught without listing every possible inner testid.
 */
const CHILD_ISSUES_EXCLUDE_SELECTOR =
  '[data-testid*="child-issues-panel"], [aria-label="Child work items section"]';

/**
 * Jira's own drag-reorder chrome around the field list: `sortable-item-list`
 * and its `sortable-item-container-<id>` / `draggable-container` /
 * `droppable-container` wrappers. These aren't fields, but
 * `sortable-item-container-customfield_X`'s testid contains "field"
 * (via "customfield"), so it can match FIELD_SELECTOR/CONTAINER_MARKER_SELECTOR
 * like a real field. Confirmed live: querySelectorAll returns it before the
 * real (narrower) field marker nested inside it, so the containment-collapse
 * dedup in listFields picks the chrome node as the sole candidate, discarding
 * the real one — findContainer then can't find any marker above it and falls
 * back to climbing for the nearest ancestor with ANY label-ish descendant,
 * which can land on `droppable-container` (wraps every sibling field) when a
 * neighboring field happens to expose a label-matching testid. Excluded
 * outright, like GLOBAL_NAV_EXCLUDE_SELECTOR.
 *
 * Also covers the next layer of layout chrome out: Jira's collapsible
 * section wrappers (`...ui.context-group.*`, `...collapsible-group-factory.*`
 * — e.g. "Your pinned fields", "Development", "Automation"). Once
 * sortable-item-list is excluded, the same climb-for-nearest-labeled-ancestor
 * fallback above just walks past it and lands on THIS wrapper instead (it
 * also contains many labeled fields, so `querySelector(LABEL_SELECTOR)`
 * matches), wrongly treating an entire collapsible section as one field's
 * container. Its testid also substring-matches PANEL_SELECTOR (contains
 * "panel" for some sections, e.g. "development-context-panel"), so
 * listPanels() must exclude it too — see its candidate-filter loop.
 */
const SORTABLE_CHROME_EXCLUDE_SELECTOR =
  '[data-testid*="sortable-item-list"], [data-testid*="context-group"], [data-testid*="collapsible-group-factory"]';

/**
 * Selector for Jira's collapsible section wrappers (e.g. "Details",
 * "Development"). These are the same nodes excluded from field/panel scanning
 * via SORTABLE_CHROME_EXCLUDE_SELECTOR — they're not fields themselves, but
 * we want to auto-hide them when all their child fields are hidden.
 */
const SECTION_SELECTOR =
  '[data-testid*="context-group"], [data-testid*="collapsible-group-factory"]';

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
 * - "issue-field-status": Status's view/edit container (label derives from
 *   the current status value, not "Status", so PROTECTED_LABELS misses it).
 * - "ref-spotlight-target-status-spotlight": Status's onboarding-tour
 *   spotlight wrapper.
 */
const PROTECTED_TESTID_SUBSTRINGS = ['issue-field-summary', 'issue-field-status', 'ref-spotlight-target-status-spotlight'];

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
      if (!current.matches(SORTABLE_CHROME_EXCLUDE_SELECTOR) && current.matches(CONTAINER_MARKER_SELECTOR)) {
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
    if (!node.matches(SORTABLE_CHROME_EXCLUDE_SELECTOR) && node.matches(CONTAINER_MARKER_SELECTOR)) {
      // Climb up looking for the closest labeled ancestor — that's the real
      // "field row". Checking only the immediate parent misses the case where
      // sibling field-matching elements (e.g. a labels read-view div and an
      // edit button, each in their own anonymous wrapper) live under a shared
      // labeled container: each sibling resolved to its own anonymous wrapper
      // and each got a separate toggle button.
      let p: Element | null = node.parentElement;
      for (let i = 0; i < MAX_CONTAINER_WALK && p; i++) {
        try {
          if (!p.matches(SORTABLE_CHROME_EXCLUDE_SELECTOR) && p.querySelector(LABEL_SELECTOR)) {
            return p;
          }
        } catch {
          // ignore selector errors at this level
        }
        p = p.parentElement;
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
    if (el.matches(SORTABLE_CHROME_EXCLUDE_SELECTOR)) {
      continue;
    }
    if (kept.some((k) => k.contains(el))) {
      continue;
    }
    kept.push(el);
  }

  // ponytail: dedupe by containerNode — siblings inside the same field
  // wrapper (e.g. labels inline-edit parts) each match FIELD_SELECTOR but
  // resolve to the same container; only the first one wins a toggle button.
  const seenContainers = new Set<Element>();

  for (const el of kept) {
    try {
      if (!(el instanceof HTMLElement)) {
        continue;
      }
      if (el.closest(GLOBAL_NAV_EXCLUDE_SELECTOR)) {
        continue;
      }
      if (el.closest(CHILD_ISSUES_EXCLUDE_SELECTOR)) {
        continue;
      }
      const label = deriveLabel(el);
      const containerNode = headingOnlySet.has(el) ? findHeadingContainer(el) : findContainer(el);
      if (!(containerNode instanceof HTMLElement)) {
        continue;
      }
      if (seenContainers.has(containerNode)) {
        continue;
      }
      seenContainers.add(containerNode);
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
 * Query `root` (defaults to `document`) for Jira's collapsible section
 * wrappers (e.g. "Details", "Development") — the same nodes that
 * SORTABLE_CHROME_EXCLUDE_SELECTOR prevents from being treated as field
 * containers. Returns raw HTMLElement[] since a section IS its own container;
 * there's no separate "value node" distinction needed.
 */
export function listSections(root?: ParentNode): HTMLElement[] {
  const scope = root ?? document;
  try {
    return Array.from(scope.querySelectorAll(SECTION_SELECTOR)).filter(
      (el): el is HTMLElement => el instanceof HTMLElement
    );
  } catch {
    return [];
  }
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
      if (el.closest(CHILD_ISSUES_EXCLUDE_SELECTOR)) {
        continue;
      }
      // Jira's own collapsible-section wrappers (e.g.
      // "...collapsible-group-factory.development-context-panel") substring-
      // match PANEL_SELECTOR via "panel" but are layout chrome around a whole
      // group of fields, not a single third-party app panel — see
      // SORTABLE_CHROME_EXCLUDE_SELECTOR's doc comment.
      if (el.matches(SORTABLE_CHROME_EXCLUDE_SELECTOR)) {
        continue;
      }
      const label = deriveLabel(el);
      const id = deriveFieldId(el, label);

      // ponytail: climb to parent only when it wraps the panel title sibling
      const titleSibling = el.parentElement?.querySelector('[data-testid$=".title"]');
      const containerNode = (titleSibling && el.parentElement instanceof HTMLElement)
        ? el.parentElement
        : el;

      const meta: FieldMeta = {
        id,
        label,
        node: el,
        containerNode,
        protected: PROTECTED_LABELS.has(normalizeLabel(label)),
      };
      byId.set(id, meta);
    } catch {
      continue;
    }
  }

  return Array.from(byId.values());
}
