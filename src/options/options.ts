import {
  loadPrefs,
  clearPref,
  clearPrefs,
  loadFieldLabels,
  toggleField,
  getPref,
  loadActivations,
  setActivated,
  buildExport,
  getSyncUsage,
  mergeActivations,
  quotaMessage,
  saveSettings,
  writeBuckets,
} from '../lib/storage-service';
import { validateExport } from '../lib/export-schema';
import type { Pref, PrefsStore } from '../types/prefs';
import { makeScopeKey, parseScopeKey } from '../types/prefs';

const PREFS_LIST_ID = 'prefs-list';
const CLEAR_ALL_BTN_ID = 'clear-all-btn';
const SEARCH_ID = 'prefs-search';
const NO_MATCH_ID = 'prefs-no-match';
const STORAGE_USAGE_ID = 'storage-usage';
const STORAGE_ERROR_ID = 'storage-error';
const STORAGE_STATUS_ID = 'storage-status';
const EXPORT_BTN_ID = 'export-btn';
const IMPORT_INPUT_ID = 'import-input';
const MAX_IMPORT_BYTES = 256 * 1024;

/** Sets the text of #storage-error / #storage-status; null hides the element. */
function showMessage(id: string, text: string | null): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text === null ? '' : text.length > 300 ? `${text.slice(0, 300)}…` : text;
  el.hidden = text === null;
}

// ponytail: same 5 lines as popup.ts — two entry points, no shared UI module worth adding.
async function refreshUsage(): Promise<void> {
  const el = document.getElementById(STORAGE_USAGE_ID);
  if (!el) return;
  try {
    const { bytes, quota } = await getSyncUsage();
    el.textContent = `Sync storage: ${(bytes / 1024).toFixed(1)} of ${Math.round(quota / 1024)} KB`;
    el.classList.toggle('jfv-warning', bytes >= quota * 0.8);
  } catch (e) {
    console.warn('[jfv] usage unavailable', e);
    el.textContent = '';
    el.classList.remove('jfv-warning');
  }
}

/** Hide groups whose data-search text lacks the query (case-insensitive). */
function applyFilter(): void {
  const q = (document.getElementById(SEARCH_ID) as HTMLInputElement | null)?.value
    .trim()
    .toLowerCase() ?? '';
  const groups = document.querySelectorAll<HTMLElement>('.jfv-project-group');
  let shown = 0;
  groups.forEach((g) => {
    const hit = !q || (g.dataset.search ?? '').includes(q);
    g.hidden = !hit;
    if (hit) shown++;
  });
  const none = document.getElementById(NO_MATCH_ID);
  if (none) none.hidden = !(q && groups.length > 0 && shown === 0);
}

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
    await refreshUsage();
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
    const searchText = [host, projectKey];

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
      group.dataset.search = searchText.join(' ').toLowerCase();
      container.appendChild(group);
      continue;
    }

    for (const pref of prefsForScope) {
      searchText.push(pref.issueTypeId, titleize(pref.issueTypeId));
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
        searchText.push(fieldLabel.textContent);

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

    group.dataset.search = searchText.join(' ').toLowerCase();
    container.appendChild(group);
  }
  applyFilter();
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

// HR-17: Blob + <a download>, no downloads permission.
async function handleExport(): Promise<void> {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(await buildExport(), null, 2)], { type: 'application/json' })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `field-ninja-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); // Firefox needs the anchor in the document
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * HR-21 trust boundary: size check before reading, full validateExport,
 * confirm, then all-or-nothing prefs write (quota precheck inside
 * writeBuckets); activations/settings only after prefs landed.
 */
export async function handleImportFile(file: File): Promise<void> {
  showMessage(STORAGE_ERROR_ID, null);
  showMessage(STORAGE_STATUS_ID, null);
  if (file.size > MAX_IMPORT_BYTES) {
    showMessage(STORAGE_ERROR_ID, `Import file too large (${Math.ceil(file.size / 1024)} KB > 256 KB).`);
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    showMessage(STORAGE_ERROR_ID, 'Import failed: not a valid JSON file.');
    return;
  }
  const result = validateExport(raw);
  if (!result.ok) {
    showMessage(STORAGE_ERROR_ID, `Import failed: ${result.error}`);
    return;
  }
  const { data, summary: s } = result;
  const what = `${s.projects} projects, ${s.buckets} issue types, ${s.fields} hidden fields, ${s.activations} activations${s.hasSettings ? ', settings' : ''}`;
  if (!confirm(`Import ${what}? Matching issue types are overwritten, others kept.`)) return;

  const buckets: Pref[] = Object.entries(data.prefs).flatMap(([scope, shard]) => {
    const { host, projectKey } = parseScopeKey(scope)!; // validateExport guarantees "<host>:<PROJ>"
    return Object.entries(shard).map(([issueTypeId, hiddenFieldIds]) => ({ host, projectKey, issueTypeId, hiddenFieldIds }));
  });
  try {
    await writeBuckets(buckets, 'replace');
  } catch (e) {
    console.warn('[jfv] import failed', e);
    showMessage(STORAGE_ERROR_ID, quotaMessage(e) ?? 'Import failed.');
    return;
  }
  try {
    await mergeActivations(data.activations);
    if (data.settings) await saveSettings(data.settings);
    showMessage(STORAGE_STATUS_ID, `Imported ${what}.`);
  } catch (e) {
    console.warn('[jfv] import activations/settings failed', e);
    showMessage(STORAGE_ERROR_ID, `Prefs imported; activations/settings failed: ${quotaMessage(e) ?? String(e)}`);
  }
  void render(await loadPrefs());
}

async function init(): Promise<void> {
  const store = await loadPrefs();
  void render(store);

  document.getElementById(SEARCH_ID)?.addEventListener('input', applyFilter);

  const clearAllBtn = document.getElementById(CLEAR_ALL_BTN_ID);
  clearAllBtn?.addEventListener('click', () => {
    void handleClearAll();
  });

  document.getElementById(EXPORT_BTN_ID)?.addEventListener('click', () => {
    void handleExport();
  });

  const importInput = document.getElementById(IMPORT_INPUT_ID) as HTMLInputElement | null;
  importInput?.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = ''; // picking the same file again must fire `change` again
    if (file) void handleImportFile(file);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
