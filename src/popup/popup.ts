import {
  clearPrefs,
  getSyncUsage,
  isActivated,
  loadSettings,
  quotaMessage,
  saveSettings,
  setActivated,
  setHiddenFields,
  toggleField,
} from '../lib/storage-service';
import { isEligibleUrl } from '../lib/jira-context-resolver';
import type { GetFieldsResponse } from '../types/messages';

const SHOW_BUTTONS_CHECKBOX_ID = 'show-buttons-checkbox';
const DEBUG_OUTLINE_CHECKBOX_ID = 'debug-outline-checkbox';
const SHRINK_COVER_CHECKBOX_ID = 'shrink-cover-checkbox';
const COVER_HEIGHT_INPUT_ID = 'cover-height-input';
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
const STORAGE_USAGE_ID = 'storage-usage';
const STORAGE_ERROR_ID = 'storage-error';

type PopupState = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

let latestResponse: GetFieldsResponse | undefined;
let coverHeightDebounceTimer: ReturnType<typeof setTimeout> | undefined;

function setHidden(el: Element | null, hidden: boolean): void {
  el?.classList.toggle('jfv-hidden', hidden);
}

async function refreshUsage(): Promise<void> {
  const el = document.getElementById(STORAGE_USAGE_ID);
  if (!el) return;
  const { bytes, quota } = await getSyncUsage();
  el.textContent = `Sync storage: ${(bytes / 1024).toFixed(1)} of ${Math.round(quota / 1024)} KB`;
  el.classList.toggle('jfv-warning', bytes >= quota * 0.8);
}

/** Runs one storage write; on failure shows quota text (or a generic one) in #storage-error. */
async function guardedWrite(fn: () => Promise<unknown>): Promise<boolean> {
  const box = document.getElementById(STORAGE_ERROR_ID);
  setHidden(box, true);
  try {
    await fn();
    return true;
  } catch (e) {
    console.warn('[jfv] storage write failed', e);
    if (box) box.textContent = quotaMessage(e) ?? 'Saving failed.';
    setHidden(box, false);
    return false;
  }
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
      void (async () => {
        const ok = await guardedWrite(() => toggleField(host, projectKey, issueTypeId, field.id, !checkbox.checked));
        if (!ok) checkbox.checked = !checkbox.checked;
        await refreshUsage();
      })();
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
  if (!(await guardedWrite(() => setActivated(response.host, response.projectKey as string, activate)))) return;
  if (activate) {
    // ACK = content script's isActive flag flipped (render may still be in flight); poll GET_FIELDS, 200ms total as timeout fallback.
    const deadline = Date.now() + 200;
    let tabId: number | undefined;
    while (Date.now() < deadline) {
      try {
        tabId ??= (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id!;
        const r: GetFieldsResponse = await chrome.tabs.sendMessage(tabId, { type: 'GET_FIELDS' });
        if (r.isActive) break;
      } catch (e) {
        console.warn('[jfv] activate ack failed', e);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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
  await refreshUsage();
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
  } catch (e) {
    console.warn('[jfv] GET_FIELDS failed', e);
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
  const shrinkCoverCheckbox = document.getElementById(
    SHRINK_COVER_CHECKBOX_ID
  ) as HTMLInputElement | null;
  const coverHeightInput = document.getElementById(
    COVER_HEIGHT_INPUT_ID
  ) as HTMLInputElement | null;
  if (showButtonsCheckbox || debugOutlineCheckbox || shrinkCoverCheckbox || coverHeightInput) {
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
    if (shrinkCoverCheckbox) {
      shrinkCoverCheckbox.checked = settings.shrinkCover;
      if (coverHeightInput) {
        coverHeightInput.disabled = !settings.shrinkCover;
      }
      shrinkCoverCheckbox.addEventListener('change', () => {
        void saveSettings({ shrinkCover: shrinkCoverCheckbox.checked });
        if (coverHeightInput) {
          coverHeightInput.disabled = !shrinkCoverCheckbox.checked;
        }
      });
    }
    if (coverHeightInput) {
      coverHeightInput.value = String(settings.coverHeightPx);
      // ponytail: writeBack only on `change` — rewriting the field mid-typing would
      // turn a paused "5" into "20" and the next keystroke into "200".
      const commit = (writeBack: boolean): void => {
        const value = Number(coverHeightInput.value);
        const clamped = Math.min(600, Math.max(20, Number.isNaN(value) ? 20 : value));
        if (writeBack) coverHeightInput.value = String(clamped);
        void saveSettings({ coverHeightPx: clamped });
      };
      coverHeightInput.addEventListener('change', () => {
        clearTimeout(coverHeightDebounceTimer);
        commit(true);
      });
      // ponytail: also commit on input (debounced) so a value survives the
      // popup closing before `change` fires — no per-keystroke writes.
      coverHeightInput.addEventListener('input', () => {
        clearTimeout(coverHeightDebounceTimer);
        coverHeightDebounceTimer = setTimeout(() => commit(false), 400);
      });
    }
  }

  await refresh();

  const resetAllButton = document.getElementById(RESET_ALL_BUTTON_ID) as HTMLButtonElement | null;
  resetAllButton?.addEventListener('click', () => {
    if (!confirm('Reset hidden fields for every issue type?')) {
      return;
    }
    void guardedWrite(clearPrefs).then(refresh);
  });

  const hideAllButton = document.getElementById(HIDE_ALL_BUTTON_ID) as HTMLButtonElement | null;
  hideAllButton?.addEventListener('click', () => {
    void (async () => {
      if (!latestResponse?.onIssuePage) {
        return;
      }
      const { issueTypeId, projectKey, host, fields } = latestResponse;
      await guardedWrite(() => setHiddenFields(host, projectKey, issueTypeId, fields.map((f) => f.id)));
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
      await guardedWrite(() => setHiddenFields(host, projectKey, issueTypeId, []));
      await refresh();
    })();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
