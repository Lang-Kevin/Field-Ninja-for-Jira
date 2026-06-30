import { loadPrefs, clearPref, clearPrefs } from '../lib/storage-service';
import type { Pref, PrefsStore } from '../types/prefs';
import { DEFAULT_PROJECT_KEY } from '../types/prefs';

const PREFS_LIST_ID = 'prefs-list';
const CLEAR_ALL_BTN_ID = 'clear-all-btn';

function render(store: PrefsStore): void {
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
      label.textContent = `${pref.issueTypeId} — ${pref.hiddenFieldIds.length} hidden field(s)`;

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
  render(updatedStore);
}

async function handleClearAll(): Promise<void> {
  await clearPrefs();
  render({});
}

async function init(): Promise<void> {
  const store = await loadPrefs();
  render(store);

  const clearAllBtn = document.getElementById(CLEAR_ALL_BTN_ID);
  clearAllBtn?.addEventListener('click', () => {
    void handleClearAll();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
