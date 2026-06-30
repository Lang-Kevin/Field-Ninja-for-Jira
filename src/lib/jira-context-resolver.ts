/**
 * jira-context-resolver.ts (Wave 2 / Milestone 1)
 *
 * Determines which Jira issue type the user is currently viewing. The whole
 * extension's visibility rules are keyed by `issueTypeId`, so this module is
 * load-bearing — it must NEVER throw, even when Jira's DOM doesn't match our
 * assumptions (e.g. mid-navigation, A/B-tested markup, etc).
 *
 * Jira Cloud is an SPA: navigating between issues updates the URL via
 * `history.pushState`/`popstate` without a full page reload, so we also
 * expose a polling-based watcher (`watchIssueContext`) since `pushState`
 * does not fire a native browser event we can listen to directly.
 *
 * IMPORTANT: All DOM selectors in this file are PROVISIONAL — we have no
 * live Jira DOM sample yet. They will be hardened with real fixtures in
 * Wave 5/7. Every DOM read is defensively wrapped so a missing/renamed
 * element degrades to 'unknown' rather than throwing.
 */

import { debounce } from './dom-observer';

export interface IssueContext {
  issueTypeId: string;
  issueKey: string | null;
  projectKey: string | null;
}

const UNKNOWN_CONTEXT: IssueContext = { issueTypeId: 'unknown', issueKey: null, projectKey: null };

// Provisional, hardened in Wave 5/7 with real Jira fixtures.
// Jira's actual data-testid naming isn't confirmed yet, so we try a couple
// of plausible substring patterns for the issue-type badge/icon.
const ISSUE_TYPE_SELECTORS = [
  '[data-testid*="issue-type"]',
  '[data-testid*="issuetype"]',
] as const;

// Provisional, hardened in Wave 5/7 with real Jira fixtures.
const ISSUE_KEY_PATH_REGEX = /\/browse\/([A-Z][A-Z0-9]*-\d+)/;
const ISSUE_KEY_SHAPE_REGEX = /^[A-Z][A-Z0-9]*-\d+$/;

// When an issue is opened from a board/backlog (?selectedIssue=…), Jira renders
// it in a modal "detail panel" while the board cards stay in the DOM behind it.
// Every card carries its own issue-type badge + field-ish nodes, so scanning
// `document` would read the wrong issue type and treat cards as fields. Scope
// everything to this panel instead. Ordered fallback: a Jira markup change
// degrades to `document` (full-page behaviour) rather than breaking — confirmed
// live as `issue.views.issue-details.issue-modal.modal-dialog`.
const ISSUE_DETAIL_PANEL_SELECTORS = [
  '[data-testid="issue.views.issue-details.issue-modal.modal-dialog"]',
  '[data-testid*="issue-modal.modal-dialog"]',
] as const;

/**
 * Slugify an arbitrary label into a stable-ish id: lowercase, non-alnum
 * runs collapsed to a single `-`, trimmed of leading/trailing `-`.
 */
function slugify(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'unknown';
}

/**
 * Best-effort, defensively-guarded read of the issue-type badge/icon from
 * the DOM. Returns the slugified label, or null if nothing usable was found.
 * Provisional, hardened in Wave 5/7 with real Jira fixtures.
 */
function readIssueTypeFromDom(root: ParentNode = document): string | null {
  try {
    for (const selector of ISSUE_TYPE_SELECTORS) {
      let els: NodeListOf<Element> | null = null;
      try {
        els = root.querySelectorAll(selector);
      } catch {
        // Invalid selector in this environment — try the next pattern.
        continue;
      }
      if (!els) continue;

      // A selector pattern can match multiple elements on real Jira (e.g. an
      // anonymous wrapper with no label, plus the actual labeled badge/button
      // further down). Check every match for this pattern before moving on.
      for (const el of Array.from(els)) {
        // ponytail: linked-issue cards inside the panel carry their own
        // `issue-line-card-issue-type` badge — skip them so we read the
        // panel's OWN type, not a linked issue's, regardless of DOM order.
        if (el.closest('[data-testid*="issue-line-card"]')) continue;

        const label =
          el.getAttribute('aria-label') ??
          el.getAttribute('title') ??
          el.getAttribute('alt');

        if (label && label.trim().length > 0) {
          return slugify(label);
        }
      }
    }
  } catch {
    // Never throw from a DOM read — fall through to null.
  }
  return null;
}

/**
 * Best-effort, defensively-guarded parse of the issue key from the current
 * URL pathname (e.g. `/browse/ABC-123` -> `ABC-123`).
 */
function readIssueKeyFromUrl(): string | null {
  try {
    const pathname = window.location?.pathname ?? '';
    const match = ISSUE_KEY_PATH_REGEX.exec(pathname);
    if (match) return match[1];

    // Board/backlog pages with an issue preview panel open never navigate to
    // /browse/ — the key lives in the ?selectedIssue= query param instead.
    const search = window.location?.search ?? '';
    const selectedIssue = new URLSearchParams(search).get('selectedIssue');
    if (selectedIssue && ISSUE_KEY_SHAPE_REGEX.test(selectedIssue)) {
      return selectedIssue;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Best-effort synchronous read of the current issue context. Never throws.
 *
 * Resolution order:
 *  1. DOM issue-type badge/icon (aria-label / title / alt), slugified.
 *  2. URL pathname for the issue key (`/browse/ABC-123`), falling back to
 *     the `selectedIssue` query param (board/backlog preview panels).
 *  3. `{ issueTypeId: 'unknown', issueKey: null }` if nothing matched.
 */
/**
 * The DOM scope all field scanning + issue-type detection should read from.
 *
 * - Standalone issue page (`/browse/ABC-123`): the whole `document` (today's
 *   behaviour — there are no competing board cards).
 * - Board/backlog panel (`?selectedIssue=…`): the issue detail modal, so the
 *   board cards behind it (each with its own issue-type badge + field-ish
 *   nodes) are excluded. Returns an empty fragment while the panel hasn't
 *   rendered yet — better to scan nothing for a frame than to pollute the
 *   board cards; the next mutation rescan picks the panel up once it appears.
 * Never throws.
 */
export function getIssueRoot(): ParentNode {
  try {
    const pathname = window.location?.pathname ?? '';
    if (ISSUE_KEY_PATH_REGEX.test(pathname)) return document;

    const search = window.location?.search ?? '';
    if (new URLSearchParams(search).get('selectedIssue')) {
      for (const sel of ISSUE_DETAIL_PANEL_SELECTORS) {
        try {
          const el = document.querySelector(sel);
          if (el) return el;
        } catch {
          // invalid selector in this environment — try the next
        }
      }
      // Panel mode but panel not in the DOM yet: scan nothing, not the board.
      return document.createDocumentFragment();
    }
  } catch {
    // fall through — scan nothing rather than pollute board cards
  }
  // ponytail: non-issue URL (bare board, backlog, …) — return empty root so listFields() scans nothing
  return document.createDocumentFragment();
}

export function getIssueType(): IssueContext {
  try {
    // Gate on the URL, not just a DOM badge: issue-type icons also render on
    // board/backlog cards, so a DOM-only check would activate the extension
    // outside of a single issue's detail view.
    const issueKey = readIssueKeyFromUrl();
    if (issueKey === null) {
      return { ...UNKNOWN_CONTEXT };
    }

    const issueTypeId = readIssueTypeFromDom(getIssueRoot());
    const projectKey = issueKey.replace(/-\d+$/, '');
    return {
      issueTypeId: issueTypeId ?? 'unknown',
      issueKey,
      projectKey,
    };
  } catch {
    // Belt-and-suspenders: this function must never throw.
    return { ...UNKNOWN_CONTEXT };
  }
}

/**
 * Convenience wrapper returning just the current issue type id.
 */
export function getCurrentIssueType(): string {
  return getIssueType().issueTypeId;
}

/**
 * Callers must use this before persisting/applying prefs keyed by
 * `issueTypeId` — 'unknown' is a sentinel for "not yet resolved", not a real
 * Jira issue type, and must never become a storage bucket.
 */
export function isKnownIssueType(issueTypeId: string): boolean {
  return issueTypeId !== 'unknown';
}

/**
 * Sets up SPA-navigation-aware watching of the current issue context.
 *
 * Jira Cloud navigates via `history.pushState`, which does not fire a
 * native event, so in addition to listening for `popstate` we poll
 * (debounced) comparing `location.href` against its previous value. The
 * callback is invoked only when the resolved `issueTypeId` actually
 * changes, to avoid redundant calls while staying on the same issue type.
 *
 * Returns an unsubscribe function that removes the `popstate` listener and
 * clears the polling timer.
 */
export function watchIssueContext(cb: (ctx: IssueContext) => void): () => void {
  let lastHref = '';
  let lastKey: string | null = null;

  try {
    lastHref = window.location?.href ?? '';
  } catch {
    lastHref = '';
  }

  const checkForChange = (): void => {
    let currentHref = '';
    try {
      currentHref = window.location?.href ?? '';
    } catch {
      currentHref = '';
    }

    if (currentHref === lastHref) {
      return;
    }
    lastHref = currentHref;

    const ctx = getIssueType();
    // Use composite key so CSM-1(Incident) → ITSM-2(Incident) fires the cb
    // even when issueTypeId is unchanged across projects.
    const key = `${ctx.projectKey}:${ctx.issueTypeId}`;
    if (key !== lastKey) {
      lastKey = key;
      try {
        cb(ctx);
      } catch {
        // Don't let a misbehaving consumer break the watcher.
      }
    }
  };

  const debouncedCheck = debounce(checkForChange, 300);

  // Polling covers both popstate and pushState-driven navigations (the
  // latter fires no native event), so a separate popstate listener would be
  // redundant — the next poll tick always re-checks location.href anyway.
  const intervalId = setInterval(debouncedCheck, 300);

  return () => {
    clearInterval(intervalId);
  };
}
