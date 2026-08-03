import {
  clearPrefs,
  isActivated,
  loadSettings,
  saveSettings,
  setActivated,
  setHiddenFields,
  toggleField,
} from '../lib/storage-service';
import { isEligibleUrl } from '../lib/jira-context-resolver';
import type { GetFieldsResponse } from '../types/messages';

const SHOW_BUTTONS_CHECKBOX_ID = 'show-buttons-checkbox';
const DEBUG_OUTLINE_CHECKBOX_ID = 'debug-outline-checkbox';
const STATUS_MESSAGE_ID = 'status-message';
const SCOPE_BAR_ID = 'scope-bar';
const SCOPE_LABEL_ID = 'scope-label';
const ACTIVATE_BUTTON_ID = 'activate-button';
const FIELD_LIST_ID = 'field-list';
const FIELD_BUTTON_ROW_ID = 'field-button-row';
const RESET_ALL_BUTTON_ID = 'reset-all-button';
const SETTINGS_BLOCK_ID = 'settings-block';
const HIDE_ALL_BUTTON_ID = 'hide-all-button';
const SHOW_ALL_BUTTON_ID = 'show-all-button';

type PopupState = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

let latestResponse: GetFieldsResponse | undefined;

function setHidden(el: Element | null, hidden: boolean): void {
  el?.classList.toggle('jfv-hidden', hidden);
}

function renderFields(response: GetFieldsResponse): void {
  const hideAllButton = document.getElementById(HIDE_ALL_BUTTON_ID) as HTMLButtonElement | null;
  const showAllButton = document.getElementById(SHOW_ALL_BUTTON_ID) as HTMLButtonElement | null;
  const disabled = !response.onIssuePage;
  if (hideAllButton) hideAllButton.disabled = disabled;
  if (showAllButton) showAllButton.disabled = disabled;

  const container = document.getElementById(FIELD_LIST_ID);
  if (!container) {
    return;
  }
  container.replaceChildren();

  if (!response.onIssuePage || response.fields.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'jfv-popup-empty';
    empty.textContent = response.onIssuePage
      ? 'No hideable fields found on this page.'
      : 'Open an issue to manage its fields.';
    container.appendChild(empty);
    return;
  }

  const { issueTypeId, projectKey, host } = response;
  for (const field of response.fields) {
    const row = document.createElement('label');
    row.className = 'jfv-field-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !field.hidden;
    checkbox.addEventListener('change', () => {
      void toggleField(host, projectKey, issueTypeId, field.id, !checkbox.checked);
    });

    const labelText = document.createElement('span');
    labelText.className = 'jfv-field-label';
    labelText.textContent = field.label;

    row.appendChild(checkbox);
    row.appendChild(labelText);
    container.appendChild(row);
  }
}

async function handleActivate(response: GetFieldsResponse, activate: boolean): Promise<void> {
  if (response.projectKey === null) return;
  await setActivated(response.host, response.projectKey, activate);
  if (activate) {
    // ponytail: kein ACK-Message — 200ms decken den In-Process-storage.onChanged-Roundtrip. ACK nachrüsten, falls es je flackert.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await refresh();
}

function renderState(state: PopupState, response?: GetFieldsResponse): void {
  const statusMessage = document.getElementById(STATUS_MESSAGE_ID);
  const scopeBar = document.getElementById(SCOPE_BAR_ID);
  const scopeLabel = document.getElementById(SCOPE_LABEL_ID);
  const activateButton = document.getElementById(ACTIVATE_BUTTON_ID) as HTMLButtonElement | null;
  const fieldList = document.getElementById(FIELD_LIST_ID);
  const fieldButtonRow = document.getElementById(FIELD_BUTTON_ROW_ID);
  const resetAllButton = document.getElementById(RESET_ALL_BUTTON_ID);
  const settingsBlock = document.getElementById(SETTINGS_BLOCK_ID);

  const showsFields = state === 'S4' || state === 'S5';
  setHidden(statusMessage, true);
  setHidden(scopeBar, true);
  setHidden(fieldList, !showsFields);
  setHidden(fieldButtonRow, !showsFields);
  setHidden(resetAllButton, state === 'S0' || state === 'S1');
  setHidden(settingsBlock, state === 'S0');

  switch (state) {
    case 'S0':
      setHidden(statusMessage, false);
      if (statusMessage) statusMessage.textContent = 'Not available on this page.';
      break;
    case 'S1':
      setHidden(statusMessage, false);
      if (statusMessage) statusMessage.textContent = 'Reload the page to enable Field Ninja.';
      break;
    case 'S2':
      setHidden(statusMessage, false);
      if (statusMessage) {
        statusMessage.textContent = 'No project detected — open an issue or a project board.';
      }
      break;
    case 'S3':
      if (!response) break;
      setHidden(scopeBar, false);
      if (scopeLabel) scopeLabel.textContent = `${response.host} · ${response.projectKey}`;
      if (activateButton) {
        activateButton.textContent = 'Enable here';
        activateButton.classList.add('jfv-primary');
        activateButton.onclick = () => void handleActivate(response, true);
      }
      break;
    case 'S4':
    case 'S5':
      if (!response) break;
      setHidden(scopeBar, false);
      if (scopeLabel) {
        scopeLabel.textContent =
          state === 'S4' ? `Active on ${response.projectKey}` : `${response.host} · ${response.projectKey}`;
      }
      if (activateButton) {
        activateButton.textContent = 'Disable here';
        activateButton.classList.remove('jfv-primary');
        activateButton.onclick = () => void handleActivate(response, false);
      }
      renderFields(response);
      break;
  }
}

async function refresh(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isEligibleUrl(tab?.url)) {
    latestResponse = undefined;
    renderState('S0');
    return;
  }
  if (tab?.id === undefined) {
    latestResponse = undefined;
    renderState('S1');
    return;
  }

  let response: GetFieldsResponse;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_FIELDS' });
  } catch {
    // No content script on this tab (e.g. older tab than the extension install).
    latestResponse = undefined;
    renderState('S1');
    return;
  }

  latestResponse = response;

  if (response.projectKey === null) {
    renderState('S2');
    return;
  }

  const activated = await isActivated(response.host, response.projectKey);
  if (!activated) {
    renderState('S3', response);
    return;
  }

  renderState(response.onIssuePage ? 'S5' : 'S4', response);
}

async function init(): Promise<void> {
  const showButtonsCheckbox = document.getElementById(
    SHOW_BUTTONS_CHECKBOX_ID
  ) as HTMLInputElement | null;
  const debugOutlineCheckbox = document.getElementById(
    DEBUG_OUTLINE_CHECKBOX_ID
  ) as HTMLInputElement | null;
  if (showButtonsCheckbox || debugOutlineCheckbox) {
    const settings = await loadSettings();
    if (showButtonsCheckbox) {
      showButtonsCheckbox.checked = settings.showFieldButtons;
      showButtonsCheckbox.addEventListener('change', () => {
        void saveSettings({ showFieldButtons: showButtonsCheckbox.checked });
      });
    }
    if (debugOutlineCheckbox) {
      debugOutlineCheckbox.checked = settings.debugOutline;
      debugOutlineCheckbox.addEventListener('change', () => {
        void saveSettings({ debugOutline: debugOutlineCheckbox.checked });
      });
    }
  }

  await refresh();

  const resetAllButton = document.getElementById(RESET_ALL_BUTTON_ID) as HTMLButtonElement | null;
  resetAllButton?.addEventListener('click', () => {
    if (!confirm('Reset hidden fields for every issue type?')) {
      return;
    }
    void clearPrefs().then(refresh);
  });

  const hideAllButton = document.getElementById(HIDE_ALL_BUTTON_ID) as HTMLButtonElement | null;
  hideAllButton?.addEventListener('click', () => {
    void (async () => {
      if (!latestResponse?.onIssuePage) {
        return;
      }
      const { issueTypeId, projectKey, host, fields } = latestResponse;
      try {
        await setHiddenFields(
          host,
          projectKey,
          issueTypeId,
          fields.map((f) => f.id)
        );
      } catch {
        alert('Too many fields for the sync storage quota.');
      }
      await refresh();
    })();
  });

  const showAllButton = document.getElementById(SHOW_ALL_BUTTON_ID) as HTMLButtonElement | null;
  showAllButton?.addEventListener('click', () => {
    void (async () => {
      if (!latestResponse?.onIssuePage) {
        return;
      }
      const { issueTypeId, projectKey, host } = latestResponse;
      await setHiddenFields(host, projectKey, issueTypeId, []);
      await refresh();
    })();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
