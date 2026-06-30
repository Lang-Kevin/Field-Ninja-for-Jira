/**
 * content-entry.ts (Wave 5)
 *
 * Content script entry point. Wires together the already-built lib modules:
 * resolves the current issue type, scans fields, applies visibility prefs,
 * mounts the per-field toggle + global panel UI, and keeps everything in
 * sync across Jira's SPA navigation and DOM mutations via the single shared
 * MutationObserver (dom-observer.ts) plus watchIssueContext's SPA-aware
 * polling — never via a second observer instance.
 */

import { getIssueType, getIssueRoot, watchIssueContext } from '../lib/jira-context-resolver';
import { listFields, listPanels, listTabs, listSections } from '../lib/field-registry';
import { getPref, onPrefsChanged, getWriteSeqStatus, waitForWritesToSettle, loadSettings, onSettingsChanged } from '../lib/storage-service';
import { computeVisibilityDiff, computeHiddenSelectors, computeHiddenTabs, computeHiddenSections, syncHiddenStylesheet, writeHiddenAttr } from '../lib/visibility-engine';
import { mountFieldToggle } from '../lib/ui-overlay';
import { observeRoot, markOwnMutation } from '../lib/dom-observer';
import { isGetFieldsMessage } from '../types/messages';
import type { ExtensionMessage, GetFieldsResponse, PopupFieldInfo } from '../types/messages';
import type { FieldMeta } from '../types/field-meta';

const RESCAN_DEBOUNCE_MS = 300;

/**
 * Combines listFields() (native Jira fields) and listPanels() (third-party
 * sidebar app panels, e.g. Automation/Tempo) into the single field list used
 * everywhere this content script needs "all hideable things on the page".
 */
function listAll(root?: ParentNode): FieldMeta[] {
  const byId = new Map<string, FieldMeta>();
  for (const field of [...listFields(root), ...listPanels(root)]) {
    byId.set(field.id, field);
  }
  return Array.from(byId.values());
}

/** Current issue type id, updated by watchIssueContext's callback. */
let currentIssueTypeId: string = 'unknown';

/**
 * Persists which tab data-testid values are known to be hidden (all their
 * fields hidden) across Jira tab switches. Jira lazy-removes inactive tab
 * panels from the DOM, so listTabs() only ever returns the active tab —
 * without this memory, every inactive tab's hidden state is lost on switch.
 * Cleared on page navigation (render([]) with fields.length === 0).
 */
const knownHiddenTabTestIds = new Set<string>();

/**
 * Maps tabTestId → fieldIds[] for the current issue type. Persisted to
 * chrome.storage.local so a page reload can re-derive which tabs are empty
 * without waiting for the user to visit each tab again.
 * Reset in loadHiddenFieldIdsAndRender on issue-type change.
 */
let tabFieldMap: Record<string, string[]> = {};

/**
 * Mirrors knownHiddenTabTestIds / tabFieldMap but for collapsible section
 * wrappers ("Details", "Development"). A section's fields are lazy-rendered
 * only when it's expanded, so we can't evaluate "all hidden" while it's
 * collapsed — we persist the field→section mapping and re-derive on each
 * render from the accumulated map, just like tab panels.
 */
const knownHiddenSectionTestIds = new Set<string>();
let sectionFieldMap: Record<string, string[]> = {};

/**
 * fieldId → human label, persisted to chrome.storage.local per issue type. A
 * field hidden inside a collapsed section / inactive tab is lazy-removed from
 * the DOM by Jira on reload, so listAll() can't re-derive its label — this
 * cache lets the popup still name (and thus unhide) it. ponytail: unbounded;
 * prune per-issue-type only if storage.local quota ever bites.
 */
let labelById: Record<string, string> = {};

/** Whether the current page is an actual issue detail page (issueKey !== null). */
let onIssuePage = false;

/** Whether per-field eye toggle buttons should be mounted on the page, per the popup's setting. */
let showFieldButtons = true;

/**
 * In-memory cache of the current issue type's hidden-field-id set. This is
 * the single source of truth `render()` applies to the DOM/UI — it is NEVER
 * re-derived by re-reading chrome.storage.sync from a generic DOM-mutation
 * rescan (see loadHiddenFieldIds/onPrefsChanged below for why).
 */
let currentHiddenFieldIds: Set<string> = new Set();

/**
 * Map from containerNode → cleanup fn for all currently-mounted per-field
 * toggle buttons. Keyed by the actual DOM node so we can skip remounting
 * buttons that are already live (avoids DOM churn inside field containers
 * that can close Jira popup dropdowns, e.g. the Sprint picker).
 * ponytail: replaces the old fieldToggleCleanups array.
 */
let fieldToggleMap = new Map<HTMLElement, () => void>();

/**
 * Passed into mountFieldToggle/mountGlobalPanel as onCommit: fires
 * synchronously the instant a click/checkbox commits a toggle, updating
 * currentHiddenFieldIds immediately. Without this, a click's optimistic DOM
 * write was reverted by the very next observeRoot rescan (any Jira-driven
 * mutation within RESCAN_DEBOUNCE_MS) because that rescan's render() still
 * diffed against the pre-click cache — the storage round-trip that would
 * otherwise refresh the cache (via onPrefsChanged) hadn't completed yet.
 */
function syncHiddenFieldIdsCache(fieldId: string, hidden: boolean): void {
  if (hidden) {
    currentHiddenFieldIds.add(fieldId);
  } else {
    currentHiddenFieldIds.delete(fieldId);
  }
}

/**
 * Re-applies visibility and re-mounts toggles + the global panel for the
 * given field list, using the in-memory currentHiddenFieldIds cache — never
 * reads storage itself. Defensively wrapped so a thrown error mid-render
 * can't crash the content script (Jira's DOM is unpredictable) — matches the
 * defensive pattern used in jira-context-resolver.ts and visibility-engine.ts.
 */
/**
 * When true, existing toggle buttons are left in place and only new containers
 * get a button mounted. Use this for DOM-mutation rescans so we don't disturb
 * active Jira popup dropdowns (removing/re-adding a button inside a field
 * container is enough to close the Sprint picker, for example).
 * Full remount (false) is still used on init, prefs change, and issue-type
 * change so button state and captured issueTypeId stay up to date.
 */
async function render(fields: FieldMeta[], skipToggleRemount = false): Promise<void> {
  try {
    const issueTypeId = currentIssueTypeId;
    const hiddenSet = currentHiddenFieldIds;

    // Tearing down/remounting toggle buttons and the panel mutates the same
    // subtree the shared observer watches. Unsuppressed, each render's own
    // mount calls would re-trigger observeRoot's callback and render again,
    // forever (the toggle button that was just clicked never settles).
    //
    // Visibility is applied synchronously from hiddenSet here (not via
    // visibility-engine's applyVisibility, which re-reads storage itself and
    // defers its write via requestAnimationFrame) — an async, deferred write
    // racing a rapid sequence of clicks' own synchronous writes is exactly
    // the bug a prior session traced rapid-toggling.test.ts's flakiness to:
    // a stale corrective write landing after the click sequence had already
    // settled the DOM correctly. hiddenSet is already this render's source
    // of truth (see currentHiddenFieldIds doc above), so no storage read is
    // needed here at all.
    // Stylesheet sync is keyed on Jira's own stable attributes (data-testid/id),
    // not on anything this script writes onto a node — so it still hides a
    // field's replacement container the instant Jira recreates it during
    // virtualized scroll, with no rescan-debounce gap. The data-jfv-hidden
    // attribute write below is kept as a fallback for the rare field with no
    // stable attribute to key off, and still closes the original
    // inline-style-write race for nodes that persist across re-renders.
    // Compute hidden tabs before the stylesheet sync so their selectors can be
    // included in the same syncHiddenStylesheet call — tab hiding then survives
    // Jira recreating the tab strip DOM on tab switch, just like field hiding.
    // Scope tab/section scanning to the same issue root as the field list
    // (the board detail panel when ?selectedIssue is open), so board cards
    // behind the panel aren't scanned.
    const scope = getIssueRoot();
    const tabs = listTabs(scope);
    const hiddenTabsMeta = computeHiddenTabs(tabs, fields, hiddenSet);
    const sections = listSections(scope);
    const hiddenSectionNodes = computeHiddenSections(sections, fields, hiddenSet);

    // Update persistent hidden-tab memory: add newly hidden, remove tabs that
    // now have visible fields. Inactive tabs not in `tabs` are left untouched —
    // their panels are lazy-removed by Jira so we can't re-evaluate them.
    if (fields.length > 0 || tabs.length > 0) {
      // Update map for currently visible panels, save so reload can re-derive
      const tabKey = `jfv-tab-fields:v1:${issueTypeId}`;
      let mapUpdated = false;
      for (const tab of tabs) {
        const testId = tab.tabNode.getAttribute('data-testid');
        if (!testId) continue;
        tabFieldMap[testId] = fields.filter(f => tab.panelNode.contains(f.containerNode)).map(f => f.id);
        mapUpdated = true;
      }
      if (mapUpdated) chrome.storage.local.set({ [tabKey]: tabFieldMap }).catch(() => {});

      // Persist field-id→label cache so hidden fields lazy-removed by Jira
      // (in collapsed sections / inactive tabs) can still be named in the popup.
      const labelKey = `jfv-field-labels:v1:${issueTypeId}`;
      let labelUpdated = false;
      for (const field of fields) {
        if (field.label && labelById[field.id] !== field.label) {
          labelById[field.id] = field.label;
          labelUpdated = true;
        }
      }
      if (labelUpdated) chrome.storage.local.set({ [labelKey]: labelById }).catch(() => {});

      // Re-derive from map (covers inactive tabs whose panels aren't in DOM)
      knownHiddenTabTestIds.clear();
      for (const [testId, fieldIds] of Object.entries(tabFieldMap)) {
        if (fieldIds.length > 0 && fieldIds.every(id => hiddenSet.has(id))) {
          knownHiddenTabTestIds.add(testId);
        }
      }

      // Override with live computation for currently visible tabs
      const hiddenTabTestIdSet = new Set(
        hiddenTabsMeta.map(t => t.tabNode.getAttribute('data-testid')).filter(Boolean) as string[]
      );
      for (const tab of tabs) {
        const testId = tab.tabNode.getAttribute('data-testid');
        if (!testId) continue;
        if (hiddenTabTestIdSet.has(testId)) {
          knownHiddenTabTestIds.add(testId);
        } else {
          knownHiddenTabTestIds.delete(testId);
        }
      }
    } else {
      knownHiddenTabTestIds.clear();
    }

    // Same persistence pattern for collapsible sections: fields are lazy-rendered
    // only when expanded, so we can't evaluate "all hidden" while collapsed.
    if (fields.length > 0 || sections.length > 0) {
      const sectionKey = `jfv-section-fields:v1:${issueTypeId}`;
      let sectionMapUpdated = false;
      // Compute live field membership once; reused for both map update and override.
      const liveSectionFields = new Map<string, FieldMeta[]>();
      for (const section of sections) {
        const testId = section.getAttribute('data-testid');
        if (!testId) continue;
        const sectionFields = fields.filter(f => section.contains(f.containerNode));
        liveSectionFields.set(testId, sectionFields);
        if (sectionFields.length > 0) {
          sectionFieldMap[testId] = sectionFields.map(f => f.id);
          sectionMapUpdated = true;
        }
      }
      if (sectionMapUpdated) chrome.storage.local.set({ [sectionKey]: sectionFieldMap }).catch(() => {});

      knownHiddenSectionTestIds.clear();
      for (const [testId, fieldIds] of Object.entries(sectionFieldMap)) {
        if (fieldIds.length > 0 && fieldIds.every(id => hiddenSet.has(id))) {
          knownHiddenSectionTestIds.add(testId);
        }
      }

      // Override with live computation only for expanded sections (fields in DOM).
      // A collapsed section has no live fields (liveSectionFields.get(testId) is empty) —
      // we cannot evaluate "all hidden" for it, so we leave knownHiddenSectionTestIds driven by the
      // persisted map above. Without this guard the override would wrongly delete
      // a collapsed section's testid (computeHiddenSections returns [] for it)
      // and the stylesheet rule would be dropped on every reload while collapsed.
      const hiddenSectionTestIdSet = new Set(
        hiddenSectionNodes.map(s => s.getAttribute('data-testid')).filter(Boolean) as string[]
      );
      for (const section of sections) {
        const testId = section.getAttribute('data-testid');
        if (!testId) continue;
        if (!liveSectionFields.get(testId)?.length) continue;
        if (hiddenSectionTestIdSet.has(testId)) {
          knownHiddenSectionTestIds.add(testId);
        } else {
          knownHiddenSectionTestIds.delete(testId);
        }
      }
    } else {
      knownHiddenSectionTestIds.clear();
    }

    const persistedTabSelectors = Array.from(knownHiddenTabTestIds).map(
      id => `[data-testid="${id}"]`
    );
    const persistedSectionSelectors = Array.from(knownHiddenSectionTestIds).map(
      id => `[data-testid="${id}"]`
    );
    syncHiddenStylesheet([
      ...computeHiddenSelectors(fields, hiddenSet),
      ...persistedTabSelectors,
      ...persistedSectionSelectors,
    ]);

    markOwnMutation(() => {
      for (const entry of computeVisibilityDiff(fields, hiddenSet)) {
        if (entry.desiredHidden) {
          entry.field.containerNode.setAttribute('data-jfv-hidden', 'true');
        } else {
          entry.field.containerNode.removeAttribute('data-jfv-hidden');
        }
      }

      // Belt-and-suspenders: also write data-jfv-hidden on tab/section nodes
      // directly, for nodes with no stable data-testid/id (stylesheet rule won't cover them).
      const hiddenTabNodes = new Set(hiddenTabsMeta.map((t) => t.tabNode));
      for (const tab of tabs) {
        writeHiddenAttr(tab.tabNode, hiddenTabNodes.has(tab.tabNode));
      }
      const hiddenSectionSet = new Set(hiddenSectionNodes);
      for (const section of sections) {
        writeHiddenAttr(section, hiddenSectionSet.has(section));
      }

      // A field can drop out of this render's `fields` list entirely (e.g. an
      // empty field's heading-only candidate gets correctly excluded once a
      // value appears nearby, per field-registry's findHeadingOnlyCandidates
      // dedup) without its DOM node being recreated. The diff loop above only
      // writes data-jfv-hidden for nodes currently IN `fields`/`tabs`, so a
      // node that was hidden under its old candidacy keeps that attribute
      // forever — orphaned, but still matched by styles.css's CSS rule.
      // Sweep it: any node still carrying the attribute that isn't currently
      // claimed by a live field or tab had its hidden marker go stale.
      //
      // Skipped when this render saw zero fields AND zero tabs — that's
      // either the deliberate render([]) on leaving an issue page (old DOM
      // may still be mid-teardown; let it go rather than flash everything
      // visible first) or Jira's first paint before any field has rendered
      // yet (same risk, same call). Sweeping is safe to defer to the next
      // render once real candidates exist again.
      if (fields.length > 0 || tabs.length > 0) {
        const liveHiddenNodes = new Set<Element>([
          ...fields.map((f) => f.containerNode),
          ...tabs.map((t) => t.tabNode),
          ...sections,
        ]);
        for (const node of Array.from(document.querySelectorAll('[data-jfv-hidden="true"]'))) {
          if (!liveHiddenNodes.has(node)) {
            node.removeAttribute('data-jfv-hidden');
          }
        }
      }

      if (!showFieldButtons) {
        // showFieldButtons off — remove all toggle buttons.
        for (const cleanup of fieldToggleMap.values()) {
          try { cleanup(); } catch {}
        }
        fieldToggleMap.clear();
      } else if (!skipToggleRemount) {
        // Full remount: prefs change, issue-type change, init, settings change.
        // Remounting with fresh `hiddenSet` + `issueTypeId` keeps button state
        // and captured issueTypeId correct.
        for (const cleanup of fieldToggleMap.values()) {
          try { cleanup(); } catch {}
        }
        fieldToggleMap.clear();
        for (const field of fields) {
          fieldToggleMap.set(
            field.containerNode,
            mountFieldToggle(field, issueTypeId, hiddenSet.has(field.id), syncHiddenFieldIdsCache)
          );
        }
      } else {
        // DOM-mutation rescan (skipToggleRemount = true): avoid touching
        // containers that already have a button — DOM writes there can close
        // Jira's popup dropdowns (e.g. the Sprint picker closes the instant
        // we remove/re-add the toggle button inside its container).
        // ponytail: button closure manages its own hidden state via onCommit.
        const liveContainers = new Set(fields.map((f) => f.containerNode));
        // Clean up buttons whose containers left the page.
        for (const [container, cleanup] of [...fieldToggleMap]) {
          if (!liveContainers.has(container)) {
            try { cleanup(); } catch {}
            fieldToggleMap.delete(container);
          }
        }
        // Mount only for containers we haven't seen before. Also skip ALL
        // new mounts while the user is actively typing/editing anywhere on
        // the page (e.g. Jira just swapped a field's read-view for a
        // brand-new edit-view/dropdown node, like the Sprint picker) —
        // mounting a button anywhere is a DOM write Jira's own open popup
        // can treat as a reason to close itself, and an open picker's
        // dropdown/options are often portal-rendered elsewhere in the DOM
        // (not inside the field's own containerNode), so a per-field
        // containment check against just that one field can't reliably
        // detect it. A global "is the user editing right now" check does,
        // regardless of where in the DOM the open picker actually lives.
        // Once focus moves elsewhere, the next rescan mounts normally.
        const userIsEditing =
          document.activeElement instanceof HTMLElement &&
          (document.activeElement.tagName === 'INPUT' ||
            document.activeElement.tagName === 'TEXTAREA' ||
            document.activeElement.isContentEditable);
        // Primary firewall: getIssueRoot() returns an empty DocumentFragment on
        // non-issue URLs (bare board, backlog, …), so `fields` is already empty
        // before this loop. The `onIssuePage` guard below is secondary defense-in-depth.
        for (const field of fields) {
          if (!fieldToggleMap.has(field.containerNode) && !userIsEditing && onIssuePage) {
            fieldToggleMap.set(
              field.containerNode,
              mountFieldToggle(field, issueTypeId, hiddenSet.has(field.id), syncHiddenFieldIdsCache)
            );
          }
        }
      }

    });
  } catch {
    // Never let a render-cycle failure crash the content script.
  }
}

/**
 * Pulls prefs for the current issue type from storage into the in-memory
 * cache, then re-renders. This is the ONLY path that reads storage directly
 * — called on init and on issue-type change, never from the DOM-mutation
 * rescan (see module doc below for the race this avoids).
 */
async function loadHiddenFieldIdsAndRender(): Promise<void> {
  const tabKey = `jfv-tab-fields:v1:${currentIssueTypeId}`;
  const sectionKey = `jfv-section-fields:v1:${currentIssueTypeId}`;
  const labelKey = `jfv-field-labels:v1:${currentIssueTypeId}`;
  try {
    const [pref, local] = await Promise.all([
      getPref(currentIssueTypeId),
      chrome.storage.local.get([tabKey, sectionKey, labelKey]),
    ]);
    currentHiddenFieldIds = new Set(pref.hiddenFieldIds);
    tabFieldMap = (local[tabKey] as Record<string, string[]>) ?? {};
    sectionFieldMap = (local[sectionKey] as Record<string, string[]>) ?? {};
    labelById = (local[labelKey] as Record<string, string>) ?? {};
  } catch {
    currentHiddenFieldIds = new Set();
    tabFieldMap = {};
    sectionFieldMap = {};
    labelById = {};
  }
  // Pre-populate from persisted maps so first render hides inactive tabs/sections correctly
  knownHiddenTabTestIds.clear();
  for (const [testId, fieldIds] of Object.entries(tabFieldMap)) {
    if (fieldIds.length > 0 && fieldIds.every(id => currentHiddenFieldIds.has(id))) {
      knownHiddenTabTestIds.add(testId);
    }
  }
  knownHiddenSectionTestIds.clear();
  for (const [testId, fieldIds] of Object.entries(sectionFieldMap)) {
    if (fieldIds.length > 0 && fieldIds.every(id => currentHiddenFieldIds.has(id))) {
      knownHiddenSectionTestIds.add(testId);
    }
  }
  void render(listAll(getIssueRoot()));
}

function init(): void {
  const ctx = getIssueType();
  currentIssueTypeId = ctx.issueTypeId;
  onIssuePage = ctx.issueKey !== null;
  if (onIssuePage) {
    void loadHiddenFieldIdsAndRender();
  }

  void loadSettings().then((settings) => {
    showFieldButtons = settings.showFieldButtons;
    if (onIssuePage) void render(listAll(getIssueRoot()));
  });
  onSettingsChanged((settings) => {
    showFieldButtons = settings.showFieldButtons;
    if (onIssuePage) void render(listAll(getIssueRoot()));
  });

  // Rescans on DOM mutation only refresh the FIELD LIST (Jira lazily renders
  // fields), reusing currentHiddenFieldIds as-is. Re-reading storage here
  // instead would race a just-committed local toggle: the click already
  // applied its result optimistically (visibility-engine + ui-overlay), but
  // chrome.storage.sync.set() is async — a rescan landing before that write
  // commits would read stale prefs and revert the user's click. Storage is
  // refreshed only via onPrefsChanged below, which fires once the write (by
  // us or another tab) has actually committed.
  observeRoot(document.body, () => {
    if (onIssuePage) void render(listAll(getIssueRoot()), true);
  }, { debounceMs: RESCAN_DEBOUNCE_MS });

  // ponytail: On re-injection into an already-settled DOM (Chrome session
  // restore), the MutationObserver above never fires because nothing else
  // mutates, so the one-shot initial render is the only chance. If it ran a
  // beat early it finds 0 fields and stays empty. Poll briefly to converge,
  // then stop the moment fields render. Harmless on fresh loads (idempotent
  // render; self-cancels once fields appear). ponytail: 300ms x 10 ≈ 3s
  // ceiling — bump the attempt cap if slow restores still miss.
  let settleAttempts = 0;
  const settleTimer = setInterval(() => {
    settleAttempts++;
    const fields = onIssuePage ? listAll(getIssueRoot()) : [];
    if (fields.length > 0) {
      void render(fields);
      clearInterval(settleTimer);
      return;
    }
    if (!onIssuePage || settleAttempts >= 10) {
      clearInterval(settleTimer);
    }
  }, 300);

  watchIssueContext((ctx) => {
    currentIssueTypeId = ctx.issueTypeId;
    onIssuePage = ctx.issueKey !== null;
    if (onIssuePage) {
      void loadHiddenFieldIdsAndRender();
    } else {
      void render([]);
    }
  });

  // Answers the popup's GET_FIELDS request with a serializable field list —
  // FieldMeta's DOM node refs can't cross the runtime messaging channel, so
  // this strips each field down to {id, label, hidden}. Synchronous, so no
  // `return true` (keeping the message channel open) is needed.
  chrome.runtime.onMessage.addListener(
    (msg: ExtensionMessage, _sender, sendResponse: (response: GetFieldsResponse) => void) => {
      if (isGetFieldsMessage(msg)) {
        let fields: PopupFieldInfo[] = [];
        if (onIssuePage) {
          const rendered = listAll(getIssueRoot()).filter((f) => !f.protected);
          const renderedIds = new Set(rendered.map((f) => f.id));
          fields = rendered.map((f) => ({ id: f.id, label: f.label, hidden: currentHiddenFieldIds.has(f.id) }));
          // Append hidden fields Jira lazy-removed from the DOM (collapsed sections /
          // inactive tabs) so they stay unhideable from the popup.
          for (const id of currentHiddenFieldIds) {
            if (!renderedIds.has(id)) {
              // ponytail: raw id fallback only if label cache never saw this field.
              fields.push({ id, label: labelById[id] ?? id, hidden: true });
            }
          }
        }
        sendResponse({ onIssuePage, issueTypeId: currentIssueTypeId, fields });
      }
    }
  );

  let settling = false;

  onPrefsChanged((store) => {
    // A rapid local click sequence issues several toggleField writes that
    // are serialized but resolve one at a time; each commit fires its own
    // onChanged event. An event landing while a NEWER local write is still
    // queued reflects an older, since-superseded state — applying it here
    // would tear down/remount toggle buttons (see render()) and reset their
    // closures to a stale baseline, so a later click on the remounted button
    // would flip from the wrong starting point. Skip those stale events;
    // once the last queued write commits, issued === committed again and
    // that final event (carrying the up-to-date snapshot) is applied.
    //
    // Tradeoff: this also skips rendering a concurrent EXTERNAL write (e.g.
    // another tab editing this same issue type) if it happens to land while
    // a local write is still in flight. That external write isn't lost —
    // storage itself isn't touched by this gate — but its render may be
    // briefly superseded by this tab's own next onChanged event. Acceptable
    // here since storage.sync's last-write-wins semantics already make "last
    // committed write reflected" the project's existing source-of-truth
    // model (see toggleField's writeQueue comment in storage-service.ts).
    const { issued, committed } = getWriteSeqStatus();
    if (issued !== committed) {
      // This event is stale, but committedWriteSeq (a local Promise
      // .finally()) and this onChanged broadcast (a separate IPC
      // round-trip) aren't guaranteed to order against each other — if
      // every event in a rapid burst arrives a tick early, every one gets
      // gated out here and, since no write follows the last click, nothing
      // would ever re-render the true final state. Wait for the queue to
      // actually drain, then re-read prefs directly instead of trusting
      // this superseded snapshot.
      // Guard against a rapid burst's several stale events each spawning
      // their own wait-then-render — wasteful, redundant DOM churn (all
      // would converge on the same final state anyway). Only one waiter
      // needs to be in flight at a time.
      if (!settling) {
        settling = true;
        void waitForWritesToSettle()
          .then(loadHiddenFieldIdsAndRender)
          .finally(() => {
            settling = false;
          });
      }
      return;
    }

    const pref = store[currentIssueTypeId];
    currentHiddenFieldIds = new Set(pref?.hiddenFieldIds ?? []);
    const fresh = onIssuePage ? listAll(getIssueRoot()) : [];
    void render(fresh);
  });
}

if (!(window as Window & { __jfvLoaded?: boolean }).__jfvLoaded) {
  (window as Window & { __jfvLoaded?: boolean }).__jfvLoaded = true;
  init();
}

export { init };
