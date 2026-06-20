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

import { getIssueType, watchIssueContext } from '../lib/jira-context-resolver';
import { listFields, listPanels, listTabs } from '../lib/field-registry';
import { getPref, onPrefsChanged, getWriteSeqStatus, waitForWritesToSettle, loadSettings, onSettingsChanged } from '../lib/storage-service';
import { computeVisibilityDiff, computeHiddenSelectors, computeHiddenTabs, syncHiddenStylesheet, writeHiddenAttr } from '../lib/visibility-engine';
import { mountFieldToggle } from '../lib/ui-overlay';
import { observeRoot, markOwnMutation } from '../lib/dom-observer';
import { isGetFieldsMessage } from '../types/messages';
import type { ExtensionMessage, GetFieldsResponse } from '../types/messages';
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

/** Cleanup fns for all currently-mounted per-field toggle buttons. */
let fieldToggleCleanups: Array<() => void> = [];

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
async function render(fields: FieldMeta[]): Promise<void> {
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
    syncHiddenStylesheet(computeHiddenSelectors(fields, hiddenSet));

    markOwnMutation(() => {
      for (const entry of computeVisibilityDiff(fields, hiddenSet)) {
        if (entry.desiredHidden) {
          entry.field.containerNode.setAttribute('data-jfv-hidden', 'true');
        } else {
          entry.field.containerNode.removeAttribute('data-jfv-hidden');
        }
      }

      // A tab whose fields are all hidden is hidden too, so it doesn't show
      // up empty (e.g. "Key Details" once every field inside it is toggled off).
      const tabs = listTabs();
      const hiddenTabs = new Set(computeHiddenTabs(tabs, fields, hiddenSet).map((t) => t.tabNode));
      for (const tab of tabs) {
        writeHiddenAttr(tab.tabNode, hiddenTabs.has(tab.tabNode));
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
        ]);
        for (const node of Array.from(document.querySelectorAll('[data-jfv-hidden="true"]'))) {
          if (!liveHiddenNodes.has(node)) {
            node.removeAttribute('data-jfv-hidden');
          }
        }
      }

      for (const cleanup of fieldToggleCleanups) {
        try {
          cleanup();
        } catch {
          // Ignore a misbehaving cleanup and keep unmounting the rest.
        }
      }
      fieldToggleCleanups = [];

      if (showFieldButtons) {
        for (const field of fields) {
          const cleanup = mountFieldToggle(
            field,
            issueTypeId,
            hiddenSet.has(field.id),
            syncHiddenFieldIdsCache
          );
          fieldToggleCleanups.push(cleanup);
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
  try {
    const pref = await getPref(currentIssueTypeId);
    currentHiddenFieldIds = new Set(pref.hiddenFieldIds);
  } catch {
    currentHiddenFieldIds = new Set();
  }
  void render(listAll());
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
    if (onIssuePage) void render(listAll());
  });
  onSettingsChanged((settings) => {
    showFieldButtons = settings.showFieldButtons;
    if (onIssuePage) void render(listAll());
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
    if (onIssuePage) void render(listAll());
  }, { debounceMs: RESCAN_DEBOUNCE_MS });

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
        const fields = onIssuePage
          ? listAll()
              .filter((f) => !f.protected)
              .map((f) => ({ id: f.id, label: f.label, hidden: currentHiddenFieldIds.has(f.id) }))
          : [];
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
    const fresh = onIssuePage ? listAll() : [];
    void render(fresh);
  });
}

init();

export { init };
