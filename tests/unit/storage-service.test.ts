import { describe, it, expect, beforeEach, vi } from 'vitest';

type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

function createMockArea(areaName: string, dispatch: ChangeListener) {
  let store: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string | string[] | null) => {
      if (key === null) {
        return Promise.resolve({ ...store });
      }
      if (Array.isArray(key)) {
        const result: Record<string, unknown> = {};
        for (const k of key) {
          if (k in store) result[k] = store[k];
        }
        return Promise.resolve(result);
      }
      return Promise.resolve(key in store ? { [key]: store[key] } : {});
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const k of Object.keys(items)) changes[k] = { oldValue: store[k], newValue: items[k] };
      store = { ...store, ...items };
      dispatch(changes, areaName);
      return Promise.resolve();
    }),
    remove: vi.fn((key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const k of keys) {
        if (k in store) changes[k] = { oldValue: store[k], newValue: undefined };
        delete store[k];
      }
      if (Object.keys(changes).length > 0) dispatch(changes, areaName);
      return Promise.resolve();
    }),
    QUOTA_BYTES_PER_ITEM: 8192,
    _reset: () => {
      store = {};
    },
    _raw: () => store,
  };
}

let listeners: ChangeListener[];
let mockSync: ReturnType<typeof createMockArea>;
let mockLocal: ReturnType<typeof createMockArea>;

beforeEach(() => {
  listeners = [];
  const dispatch: ChangeListener = (changes, area) => {
    for (const l of listeners) l(changes, area);
  };
  mockSync = createMockArea('sync', dispatch);
  mockLocal = createMockArea('local', dispatch);
  (globalThis as any).chrome = {
    storage: {
      sync: mockSync,
      local: mockLocal,
      onChanged: {
        addListener: (l: ChangeListener) => listeners.push(l),
        removeListener: (l: ChangeListener) => {
          listeners = listeners.filter((x) => x !== l);
        },
      },
    },
  };
});

import {
  loadPrefs,
  savePrefs,
  getPref,
  toggleField,
  clearPref,
  clearPrefs,
  loadFieldLabels,
  setHiddenFields,
  loadSettings,
  saveSettings,
  loadActivations,
  isActivated,
  setActivated,
  onActivationsChanged,
  onPrefsChanged,
  dropLegacyPrefs,
} from '../../src/lib/storage-service';
import {
  PREFS_STORAGE_KEY,
  ACTIVATIONS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  LEGACY_PREFS_KEYS,
  makePrefKey,
  makeScopeKey,
  fieldLabelKey,
} from '../../src/types/prefs';

const HOST = 'acme.atlassian.net';
const PROJECT = 'CSM';

describe('toggleField', () => {
  it('adds fieldId to a fresh issueTypeId hiddenFieldIds when hidden: true', async () => {
    const result = await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    const key = makePrefKey(HOST, PROJECT, 'TYPE_A');
    expect(result[key].hiddenFieldIds).toEqual(['field1']);
    expect(result[key].issueTypeId).toBe('TYPE_A');
    expect(result[key].projectKey).toBe(PROJECT);
    expect(result[key].host).toBe(HOST);
  });

  it('removes fieldId from hiddenFieldIds when hidden: false on an already-hidden field', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    const result = await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', false);
    const key = makePrefKey(HOST, PROJECT, 'TYPE_A');
    expect(result[key].hiddenFieldIds).toEqual([]);
  });

  it('does not duplicate fieldId when toggled hidden: true twice in a row', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    const result = await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    const key = makePrefKey(HOST, PROJECT, 'TYPE_A');
    expect(result[key].hiddenFieldIds).toEqual(['field1']);
    expect(result[key].hiddenFieldIds.length).toBe(1);
  });

  it('keeps per-issueTypeId state isolated (critical invariant)', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    await toggleField(HOST, PROJECT, 'TYPE_B', 'field2', true);

    const store = await loadPrefs();
    const keyA = makePrefKey(HOST, PROJECT, 'TYPE_A');
    const keyB = makePrefKey(HOST, PROJECT, 'TYPE_B');

    expect(store[keyA].hiddenFieldIds).toEqual(['field1']);
    expect(store[keyA].hiddenFieldIds).not.toContain('field2');
    expect(store[keyA].hiddenFieldIds.length).toBe(1);

    expect(store[keyB].hiddenFieldIds).toEqual(['field2']);
    expect(store[keyB].hiddenFieldIds).not.toContain('field1');
    expect(store[keyB].hiddenFieldIds.length).toBe(1);
  });

  it('keeps state isolated across sites (critical invariant)', async () => {
    await toggleField('a.atlassian.net', 'ABC', 'story', 'f1', true);

    const prefOnB = await getPref('b.atlassian.net', 'ABC', 'story');
    expect(prefOnB.hiddenFieldIds).toEqual([]);

    const prefOnA = await getPref('a.atlassian.net', 'ABC', 'story');
    expect(prefOnA.hiddenFieldIds).toEqual(['f1']);
  });

  it('keeps state isolated across projects on the same host', async () => {
    await toggleField(HOST, 'PROJ_A', 'story', 'f1', true);

    const prefB = await getPref(HOST, 'PROJ_B', 'story');
    expect(prefB.hiddenFieldIds).toEqual([]);

    const prefA = await getPref(HOST, 'PROJ_A', 'story');
    expect(prefA.hiddenFieldIds).toEqual(['f1']);
  });

  it('is a no-op for an empty host or a null projectKey (write guard)', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);

    await toggleField('', PROJECT, 'TYPE_A', 'field2', true);
    await toggleField(HOST, null, 'TYPE_A', 'field3', true);

    const store = await loadPrefs();
    expect(Object.keys(store)).toEqual([makePrefKey(HOST, PROJECT, 'TYPE_A')]);
    expect(store[makePrefKey(HOST, PROJECT, 'TYPE_A')].hiddenFieldIds).toEqual(['field1']);
  });
});

describe('getPref', () => {
  it('returns a fresh default pref for a non-existent issueTypeId without persisting it', async () => {
    const pref = await getPref(HOST, PROJECT, 'UNKNOWN_TYPE');
    expect(pref).toEqual({ host: HOST, projectKey: PROJECT, issueTypeId: 'UNKNOWN_TYPE', hiddenFieldIds: [] });

    const store = await loadPrefs();
    expect(store[makePrefKey(HOST, PROJECT, 'UNKNOWN_TYPE')]).toBeUndefined();
  });

  it('returns exact entry when it exists', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    const pref = await getPref(HOST, PROJECT, 'TYPE_A');
    expect(pref.projectKey).toBe(PROJECT);
    expect(pref.hiddenFieldIds).toContain('field1');
  });

  it('never matches a stored pref when projectKey is null', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    const pref = await getPref(HOST, null, 'TYPE_A');
    expect(pref.hiddenFieldIds).toEqual([]);
  });
});

describe('clearPrefs', () => {
  it('removes the prefs key, leaving activations and settings intact', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    await setActivated(HOST, PROJECT, true);
    await saveSettings({ showFieldButtons: false });

    await clearPrefs();

    const raw = mockSync._raw();
    expect(raw[PREFS_STORAGE_KEY]).toBeUndefined();
    expect(raw[ACTIVATIONS_STORAGE_KEY]).toBeDefined();
    expect(raw[SETTINGS_STORAGE_KEY]).toBeDefined();

    const store = await loadPrefs();
    expect(store).toEqual({});
  });
});

describe('clearPref', () => {
  it('removes only the specified composite entry', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    await toggleField(HOST, PROJECT, 'TYPE_B', 'field2', true);

    await clearPref(HOST, PROJECT, 'TYPE_A');

    const store = await loadPrefs();
    expect(store[makePrefKey(HOST, PROJECT, 'TYPE_A')]).toBeUndefined();
    expect(store[makePrefKey(HOST, PROJECT, 'TYPE_B')]).toBeDefined();
  });

  it('is a no-op when the entry does not exist', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    await clearPref(HOST, 'OTHER_PROJECT', 'TYPE_A');

    const store = await loadPrefs();
    expect(store[makePrefKey(HOST, PROJECT, 'TYPE_A')]).toBeDefined();
  });

  it('is a no-op for an empty host or a null projectKey', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);

    await clearPref('', PROJECT, 'TYPE_A');
    await clearPref(HOST, null, 'TYPE_A');

    const store = await loadPrefs();
    expect(store[makePrefKey(HOST, PROJECT, 'TYPE_A')]).toBeDefined();
  });
});

describe('setHiddenFields', () => {
  it('dedupes duplicate fieldIds into a single entry each, in a single write', async () => {
    const setSpy = vi.spyOn(mockSync, 'set');
    await setHiddenFields(HOST, PROJECT, 'TYPE_A', ['field1', 'field1', 'field2']);
    const store = await loadPrefs();
    const key = makePrefKey(HOST, PROJECT, 'TYPE_A');
    expect(store[key].hiddenFieldIds.sort()).toEqual(['field1', 'field2']);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an empty host or a null projectKey (write guard)', async () => {
    await setHiddenFields('', PROJECT, 'TYPE_A', ['field1']);
    await setHiddenFields(HOST, null, 'TYPE_A', ['field1']);

    const store = await loadPrefs();
    expect(store).toEqual({});
  });

  it('clears the pref when given an empty array', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    await setHiddenFields(HOST, PROJECT, 'TYPE_A', []);
    const store = await loadPrefs();
    expect(store[makePrefKey(HOST, PROJECT, 'TYPE_A')]).toBeUndefined();
  });

  it('writes the given hiddenFieldIds list in one savePrefs call', async () => {
    const setSpy = vi.spyOn(mockSync, 'set');
    await setHiddenFields(HOST, PROJECT, 'TYPE_A', ['fieldA', 'fieldB']);

    const store = await loadPrefs();
    const key = makePrefKey(HOST, PROJECT, 'TYPE_A');
    expect(store[key]).toEqual({ host: HOST, projectKey: PROJECT, issueTypeId: 'TYPE_A', hiddenFieldIds: ['fieldA', 'fieldB'] });
    expect(setSpy).toHaveBeenCalledTimes(1);
  });
});

describe('loadFieldLabels', () => {
  it('returns the stored label map when the key exists', async () => {
    const key = fieldLabelKey(HOST, PROJECT, 'TYPE_A');
    await mockLocal.set({ [key]: { field1: 'Summary' } });

    const labels = await loadFieldLabels(HOST, PROJECT, 'TYPE_A');
    expect(labels).toEqual({ field1: 'Summary' });
  });

  it('returns {} when the key is missing', async () => {
    const labels = await loadFieldLabels(HOST, PROJECT, 'TYPE_A');
    expect(labels).toEqual({});
  });

  it('returns {} when chrome.storage.local.get throws (best-effort)', async () => {
    mockLocal.get = vi.fn<[key: string | string[] | null], Promise<Record<string, unknown>>>(() => {
      throw new Error('storage unavailable');
    });

    const labels = await loadFieldLabels(HOST, PROJECT, 'TYPE_A');
    expect(labels).toEqual({});
  });
});

describe('saveSettings', () => {
  it('merges a partial write, preserving other settings fields', async () => {
    await saveSettings({ showFieldButtons: false });
    await saveSettings({ debugOutline: true });

    const settings = await loadSettings();
    expect(settings.showFieldButtons).toBe(false);
    expect(settings.debugOutline).toBe(true);
  });
});

describe('loadPrefs / savePrefs', () => {
  it('round-trips a store through savePrefs and loadPrefs', async () => {
    const key = makePrefKey(HOST, PROJECT, 'TYPE_A');
    const store = {
      [key]: { host: HOST, projectKey: PROJECT, issueTypeId: 'TYPE_A', hiddenFieldIds: ['f1', 'f2'] },
    };
    await savePrefs(store);
    const loaded = await loadPrefs();
    expect(loaded).toEqual(store);
    expect(mockSync._raw()[PREFS_STORAGE_KEY]).toEqual(store);
  });

  it('returns {} when nothing has been saved yet', async () => {
    const loaded = await loadPrefs();
    expect(loaded).toEqual({});
  });
});

describe('activations', () => {
  it('setActivated(true) makes isActivated true', async () => {
    await setActivated(HOST, PROJECT, true);
    expect(await isActivated(HOST, PROJECT)).toBe(true);
  });

  it('setActivated(false) removes the key but leaves stored hidden fields intact', async () => {
    await setActivated(HOST, PROJECT, true);
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);

    await setActivated(HOST, PROJECT, false);

    expect(await isActivated(HOST, PROJECT)).toBe(false);
    const activations = await loadActivations();
    expect(activations[makeScopeKey(HOST, PROJECT)]).toBeUndefined();

    const pref = await getPref(HOST, PROJECT, 'TYPE_A');
    expect(pref.hiddenFieldIds).toEqual(['field1']);
  });

  it('two concurrent setActivated calls both land', async () => {
    const p1 = setActivated(HOST, 'PROJ_A', true);
    const p2 = setActivated(HOST, 'PROJ_B', true);
    await Promise.all([p1, p2]);

    const activations = await loadActivations();
    expect(activations[makeScopeKey(HOST, 'PROJ_A')]).toBe(true);
    expect(activations[makeScopeKey(HOST, 'PROJ_B')]).toBe(true);
  });

  it('setActivated with an empty host or empty projectKey is a no-op', async () => {
    await setActivated('', PROJECT, true);
    await setActivated(HOST, '', true);

    const activations = await loadActivations();
    expect(activations).toEqual({});
  });
});

describe('onChanged listeners', () => {
  it('onActivationsChanged fires on an activations change and not on a prefs change', async () => {
    const cb = vi.fn();
    const unsubscribe = onActivationsChanged(cb);

    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    expect(cb).not.toHaveBeenCalled();

    await setActivated(HOST, PROJECT, true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ [makeScopeKey(HOST, PROJECT)]: true }));

    unsubscribe();
  });

  it('onPrefsChanged fires on a prefs change and not on an activations change', async () => {
    const cb = vi.fn();
    const unsubscribe = onPrefsChanged(cb);

    await setActivated(HOST, PROJECT, true);
    expect(cb).not.toHaveBeenCalled();

    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

describe('dropLegacyPrefs', () => {
  it('removes legacy sync and local keys, leaving current keys and unrelated keys intact', async () => {
    await toggleField(HOST, PROJECT, 'TYPE_A', 'field1', true);
    await setActivated(HOST, PROJECT, true);
    await saveSettings({ showFieldButtons: false });

    await mockSync.set({ 'jiraFieldVisibility:v1': { some: 'legacy' } });
    await mockSync.set({ 'jiraFieldVisibility:v2': { some: 'legacy' } });
    await mockLocal.set({
      'jfv-field-labels:v1:foo': { a: 'b' },
      'jfv-tab-fields:v1:foo': { a: 'b' },
      'jfv-section-fields:v1:foo': { a: 'b' },
      'unrelated-key': { keep: true },
    });

    await dropLegacyPrefs();

    const rawSync = mockSync._raw();
    expect(rawSync['jiraFieldVisibility:v1']).toBeUndefined();
    expect(rawSync['jiraFieldVisibility:v2']).toBeUndefined();
    expect(rawSync[PREFS_STORAGE_KEY]).toBeDefined();
    expect(rawSync[SETTINGS_STORAGE_KEY]).toBeDefined();
    expect(rawSync[ACTIVATIONS_STORAGE_KEY]).toBeDefined();

    const rawLocal = mockLocal._raw();
    expect(rawLocal['jfv-field-labels:v1:foo']).toBeUndefined();
    expect(rawLocal['jfv-tab-fields:v1:foo']).toBeUndefined();
    expect(rawLocal['jfv-section-fields:v1:foo']).toBeUndefined();
    expect(rawLocal['unrelated-key']).toEqual({ keep: true });

    expect(LEGACY_PREFS_KEYS).toEqual(['jiraFieldVisibility:v1', 'jiraFieldVisibility:v2']);
  });
});
