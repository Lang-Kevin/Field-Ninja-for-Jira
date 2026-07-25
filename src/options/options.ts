import {
  loadPrefs,
  clearPref,
  clearPrefs,
  loadFieldLabels,
  toggleField,
  getPref,
} from '../lib/storage-service';
import type { Pref, PrefsStore } from '../types/prefs';
import { DEFAULT_PROJECT_KEY } from '../types/prefs';

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

  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No saved preferences yet.';
    container.appendChild(empty);
    return;
  }

  // Group entries by projectKey.
  const grouped = new Map<string, Pref[]>();
  for (const pref of entries) {
    const key = pref.projectKey;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(pref);
  }

  // '*' (default bucket) first, then alphabetical by project key.
  const sortedProjectKeys = [...grouped.keys()].sort((a, b) => {
    if (a === DEFAULT_PROJECT_KEY) return -1;
    if (b === DEFAULT_PROJECT_KEY) return 1;
    return a.localeCompare(b);
  });

  for (const projectKey of sortedProjectKeys) {
    const group = document.createElement('div');
    group.className = 'jfv-project-group';

    const heading = document.createElement('h2');
    heading.className = 'jfv-project-heading';
    heading.textContent =
      projectKey === DEFAULT_PROJECT_KEY
        ? 'All projects (default)'
        : `Project: ${projectKey}`;
    group.appendChild(heading);

    for (const pref of grouped.get(projectKey)!) {
      const row = document.createElement('div');
      row.className = 'jfv-pref-row';

      const label = document.createElement('span');
      label.className = 'jfv-pref-label';
      label.textContent = `${titleize(pref.issueTypeId)} — ${pref.hiddenFieldIds.length} hidden field(s)`;

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'jfv-clear-btn';
      resetBtn.textContent = 'Reset';
      const projectLabel =
        projectKey === DEFAULT_PROJECT_KEY
          ? 'all projects (default)'
          : projectKey;
      resetBtn.setAttribute(
        'aria-label',
        `Reset hidden fields for ${pref.issueTypeId} in ${projectLabel}`
      );
      resetBtn.addEventListener('click', () => {
        void handleClearOne(pref.projectKey, pref.issueTypeId);
      });

      row.appendChild(label);
      row.appendChild(resetBtn);
      group.appendChild(row);

      // Per-row lazy label load — one issue type rarely has many rows.
      const labels = await loadFieldLabels(pref.projectKey, pref.issueTypeId);
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
          `Un-hide ${fieldLabel.textContent} for ${titleize(pref.issueTypeId)} in ${projectLabel}`
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
  projectKey: string,
  issueTypeId: string
): Promise<void> {
  await clearPref(projectKey, issueTypeId);
  const updatedStore = await loadPrefs();
  void render(updatedStore);
}

async function handleClearAll(): Promise<void> {
  await clearPrefs();
  void render({});
}

async function handleUnhideOne(pref: Pref, fieldId: string): Promise<void> {
  await toggleField(pref.projectKey, pref.issueTypeId, fieldId, false);
  // ponytail: drop the now-empty bucket so no 0-field ghost row lingers.
  const updated = await getPref(pref.projectKey, pref.issueTypeId);
  if (updated.hiddenFieldIds.length === 0) {
    await clearPref(pref.projectKey, pref.issueTypeId);
  }
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
