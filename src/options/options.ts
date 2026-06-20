import { loadPrefs, savePrefs } from '../lib/storage-service';
import type { PrefsStore } from '../types/prefs';

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

  for (const pref of entries) {
    const row = document.createElement('div');
    row.className = 'jfv-pref-row';

    const label = document.createElement('span');
    label.className = 'jfv-pref-label';
    label.textContent = `${pref.issueTypeId} — ${pref.hiddenFieldIds.length} hidden field(s)`;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'jfv-clear-btn';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      void handleClearOne(store, pref.issueTypeId);
    });

    row.appendChild(label);
    row.appendChild(clearBtn);
    container.appendChild(row);
  }
}

async function handleClearOne(
  store: PrefsStore,
  issueTypeId: string
): Promise<void> {
  const updatedStore: PrefsStore = { ...store };
  delete updatedStore[issueTypeId];

  await savePrefs(updatedStore);
  render(updatedStore);
}

async function handleClearAll(): Promise<void> {
  const emptyStore: PrefsStore = {};
  await savePrefs(emptyStore);
  render(emptyStore);
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
