import {
  loadPrefs,
  clearPref,
  clearPrefs,
  loadFieldLabels,
  toggleField,
  getPref,
  loadActivations,
  setActivated,
} from '../lib/storage-service';
import type { Pref, PrefsStore } from '../types/prefs';
import { makeScopeKey } from '../types/prefs';

const PREFS_LIST_ID = 'prefs-list';
const CLEAR_ALL_BTN_ID = 'clear-all-btn';

/** `user-story` -> `User Story` */
export function titleize(slug: string): string {
  return slug
    .split('-')
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Best-effort display name for a fieldId that never got a cached label.
 * ponytail: the label cache (loadFieldLabels) already covers any field that
 * has been rendered at least once — this fallback only fires for opaque ids
 * that were hidden before the extension ever saw their real label.
 */
export function humanizeFieldId(id: string): string {
  const stripped = id.replace(/^(id_|lbl_)/, '');
  const words = stripped
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return id;
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ponytail: single-page admin list — overlapping renders only happen from
// rapid clicks, so coalescing to "run once more with the latest store" is
// enough; no need for a generic mutex/queue abstraction.
let rendering = false;
let pendingStore: PrefsStore | null = null;

async function render(store: PrefsStore): Promise<void> {
  if (rendering) {
    pendingStore = store;
    return;
  }
  rendering = true;
  try {
    await doRender(store);
    while (pendingStore) {
      const next = pendingStore;
      pendingStore = null;
      await doRender(next);
    }
  } finally {
    rendering = false;
  }
}

async function doRender(store: PrefsStore): Promise<void> {
  const container = document.getElementById(PREFS_LIST_ID);
  if (!container) {
    return;
  }

  // Clear existing content without innerHTML.
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  const entries = Object.values(store);
  const activations = await loadActivations();

  // Group entries by the composite host+project scope key.
  const grouped = new Map<string, Pref[]>();
  for (const pref of entries) {
    const key = makeScopeKey(pref.host, pref.projectKey);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(pref);
  }

  // Rendered groups are the union of activated scopes and scopes with prefs
  // — deactivating a scope deliberately preserves its prefs (see storage-
  // service.setActivated), so a scope with prefs but no activation is an
  // expected state, not an orphan.
  const allScopeKeys = new Set<string>([...grouped.keys(), ...Object.keys(activations)]);

  if (allScopeKeys.size === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No saved preferences yet.';
    container.appendChild(empty);
    return;
  }

  const sortedScopeKeys = [...allScopeKeys].sort((a, b) => a.localeCompare(b));

  for (const scopeKey of sortedScopeKeys) {
    // ponytail: malformed-key guard — unreachable under current invariants
    // (makeScopeKey always includes the delimiter), but skip rather than
    // render a corrupted heading if one ever slips through.
    if (!scopeKey.includes(':')) continue;

    const prefsForScope = grouped.get(scopeKey) ?? [];
    // scopeKey format is `${host}:${projectKey}` (makeScopeKey) — a pref row
    // is the more reliable source when one exists, since host/projectKey
    // themselves never contain the delimiter in practice; fall back to
    // splitting the key for activation-only scopes with no prefs yet.
    const host = prefsForScope[0]?.host ?? scopeKey.slice(0, scopeKey.indexOf(':'));
    const projectKey = prefsForScope[0]?.projectKey ?? scopeKey.slice(scopeKey.indexOf(':') + 1);
    const isActive = activations[scopeKey] === true;

    const group = document.createElement('div');
    group.className = 'jfv-project-group';

    const heading = document.createElement('h2');
    heading.className = 'jfv-project-heading';
    heading.textContent = `${host} — ${projectKey}`;
    group.appendChild(heading);

    if (isActive) {
      const deactivateBtn = document.createElement('button');
      deactivateBtn.type = 'button';
      deactivateBtn.className = 'jfv-deactivate-btn';
      deactivateBtn.textContent = 'Deactivate';
      deactivateBtn.setAttribute('aria-label', `Deactivate for ${host} — ${projectKey}`);
      deactivateBtn.addEventListener('click', () => {
        void handleDeactivate(host, projectKey);
      });
      heading.appendChild(deactivateBtn);
    } else {
      const inactiveMarker = document.createElement('span');
      inactiveMarker.className = 'jfv-inactive-marker';
      inactiveMarker.textContent = '(inactive)';
      heading.appendChild(inactiveMarker);
    }

    if (prefsForScope.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No hidden fields.';
      group.appendChild(empty);
      container.appendChild(group);
      continue;
    }

    for (const pref of prefsForScope) {
      const row = document.createElement('div');
      row.className = 'jfv-pref-row';

      const label = document.createElement('span');
      label.className = 'jfv-pref-label';
      label.textContent = `${titleize(pref.issueTypeId)} — ${pref.hiddenFieldIds.length} hidden field(s)`;

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'jfv-clear-btn';
      resetBtn.textContent = 'Reset';
      resetBtn.setAttribute(
        'aria-label',
        `Reset hidden fields for ${pref.issueTypeId} in ${projectKey}`
      );
      resetBtn.addEventListener('click', () => {
        void handleClearOne(pref.host, pref.projectKey, pref.issueTypeId);
      });

      row.appendChild(label);
      row.appendChild(resetBtn);
      group.appendChild(row);

      // Per-row lazy label load — one issue type rarely has many rows.
      const labels = await loadFieldLabels(pref.host, pref.projectKey, pref.issueTypeId);
      for (const fieldId of pref.hiddenFieldIds) {
        const subRow = document.createElement('div');
        subRow.className = 'jfv-field-sub-row';

        const fieldLabel = document.createElement('span');
        fieldLabel.className = 'jfv-field-sub-label';
        fieldLabel.textContent = labels[fieldId] ?? humanizeFieldId(fieldId);

        const unhideBtn = document.createElement('button');
        unhideBtn.type = 'button';
        unhideBtn.className = 'jfv-unhide-btn';
        unhideBtn.textContent = '✕';
        unhideBtn.setAttribute(
          'aria-label',
          `Un-hide ${fieldLabel.textContent} for ${titleize(pref.issueTypeId)} in ${projectKey}`
        );
        unhideBtn.addEventListener('click', () => {
          void handleUnhideOne(pref, fieldId);
        });

        subRow.appendChild(fieldLabel);
        subRow.appendChild(unhideBtn);
        group.appendChild(subRow);
      }
    }

    container.appendChild(group);
  }
}

async function handleClearOne(
  host: string,
  projectKey: string,
  issueTypeId: string
): Promise<void> {
  await clearPref(host, projectKey, issueTypeId);
  const updatedStore = await loadPrefs();
  void render(updatedStore);
}

async function handleClearAll(): Promise<void> {
  await clearPrefs();
  void render({});
}

async function handleUnhideOne(pref: Pref, fieldId: string): Promise<void> {
  await toggleField(pref.host, pref.projectKey, pref.issueTypeId, fieldId, false);
  // ponytail: drop the now-empty bucket so no 0-field ghost row lingers.
  const updated = await getPref(pref.host, pref.projectKey, pref.issueTypeId);
  if (updated.hiddenFieldIds.length === 0) {
    await clearPref(pref.host, pref.projectKey, pref.issueTypeId);
  }
  void render(await loadPrefs());
}

async function handleDeactivate(host: string, projectKey: string): Promise<void> {
  await setActivated(host, projectKey, false);
  void render(await loadPrefs());
}

async function init(): Promise<void> {
  const store = await loadPrefs();
  void render(store);

  const clearAllBtn = document.getElementById(CLEAR_ALL_BTN_ID);
  clearAllBtn?.addEventListener('click', () => {
    void handleClearAll();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
