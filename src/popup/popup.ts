import { clearPrefs, loadSettings, saveSettings, toggleField } from '../lib/storage-service';
import type { GetFieldsResponse } from '../types/messages';

const SHOW_BUTTONS_CHECKBOX_ID = 'show-buttons-checkbox';
const FIELD_LIST_ID = 'field-list';
const RESET_ALL_BUTTON_ID = 'reset-all-button';

async function getActiveTabFields(): Promise<GetFieldsResponse | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    return undefined;
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'GET_FIELDS' });
  } catch {
    // No content script on this tab (e.g. not a Jira issue page).
    return undefined;
  }
}

function renderFields(response: GetFieldsResponse | undefined): void {
  const container = document.getElementById(FIELD_LIST_ID);
  if (!container) {
    return;
  }
  container.replaceChildren();

  if (!response || !response.onIssuePage || response.fields.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'jfv-popup-empty';
    empty.textContent = response?.onIssuePage
      ? 'No hideable fields found on this page.'
      : 'Open a Jira issue to manage its fields.';
    container.appendChild(empty);
    return;
  }

  const { issueTypeId, projectKey } = response;
  for (const field of response.fields) {
    const row = document.createElement('label');
    row.className = 'jfv-field-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !field.hidden;
    checkbox.addEventListener('change', () => {
      void toggleField(projectKey, issueTypeId, field.id, !checkbox.checked);
    });

    const labelText = document.createElement('span');
    labelText.className = 'jfv-field-label';
    labelText.textContent = field.label;

    row.appendChild(checkbox);
    row.appendChild(labelText);
    container.appendChild(row);
  }
}

async function init(): Promise<void> {
  const showButtonsCheckbox = document.getElementById(
    SHOW_BUTTONS_CHECKBOX_ID
  ) as HTMLInputElement | null;
  if (showButtonsCheckbox) {
    const settings = await loadSettings();
    showButtonsCheckbox.checked = settings.showFieldButtons;
    showButtonsCheckbox.addEventListener('change', () => {
      void saveSettings({ showFieldButtons: showButtonsCheckbox.checked });
    });
  }

  renderFields(await getActiveTabFields());

  const resetAllButton = document.getElementById(RESET_ALL_BUTTON_ID) as HTMLButtonElement | null;
  resetAllButton?.addEventListener('click', () => {
    if (!confirm('Reset hidden fields for every issue type?')) {
      return;
    }
    void clearPrefs().then(async () => {
      renderFields(await getActiveTabFields());
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
