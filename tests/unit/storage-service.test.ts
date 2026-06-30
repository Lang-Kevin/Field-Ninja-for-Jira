import { describe, it, expect, beforeEach, vi } from 'vitest';

function createMockChromeStorage() {
  let store: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string | string[]) => {
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
      store = { ...store, ...items };
      return Promise.resolve();
    }),
    remove: vi.fn((key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete store[k];
      return Promise.resolve();
    }),
    QUOTA_BYTES_PER_ITEM: 8192,
    _reset: () => {
      store = {};
    },
    _raw: () => store,
  };
}

let mockStorage: ReturnType<typeof createMockChromeStorage>;

beforeEach(() => {
  mockStorage = createMockChromeStorage();
  (globalThis as any).chrome = { storage: { sync: mockStorage } };
});

import {
  loadPrefs,
  savePrefs,
  getPref,
  toggleField,
  clearPref,
  clearPrefs,
  migrateIfNeeded,
} from '../../src/lib/storage-service';
import { PREFS_STORAGE_KEY, PREFS_STORAGE_KEY_V1, makePrefKey } from '../../src/types/prefs';

describe('toggleField', () => {
  it('adds fieldId to a fresh issueTypeId hiddenFieldIds when hidden: true', async () => {
    const result = await toggleField('*', 'TYPE_A', 'field1', true);
    const key = makePrefKey('*', 'TYPE_A');
    expect(result[key].hiddenFieldIds).toEqual(['field1']);
    expect(result[key].issueTypeId).toBe('TYPE_A');
    expect(result[key].projectKey).toBe('*');
  });

  it('removes fieldId from hiddenFieldIds when hidden: false on an already-hidden field', async () => {
    await toggleField('*', 'TYPE_A', 'field1', true);
    const result = await toggleField('*', 'TYPE_A', 'field1', false);
    const key = makePrefKey('*', 'TYPE_A');
    expect(result[key].hiddenFieldIds).toEqual([]);
  });

  it('does not duplicate fieldId when toggled hidden: true twice in a row', async () => {
    await toggleField('*', 'TYPE_A', 'field1', true);
    const result = await toggleField('*', 'TYPE_A', 'field1', true);
    const key = makePrefKey('*', 'TYPE_A');
    expect(result[key].hiddenFieldIds).toEqual(['field1']);
    expect(result[key].hiddenFieldIds.length).toBe(1);
  });

  it('keeps per-issueTypeId state isolated (critical invariant)', async () => {
    await toggleField('*', 'TYPE_A', 'field1', true);
    await toggleField('*', 'TYPE_B', 'field2', true);

    const store = await loadPrefs();
    const keyA = makePrefKey('*', 'TYPE_A');
    const keyB = makePrefKey('*', 'TYPE_B');

    expect(store[keyA].hiddenFieldIds).toEqual(['field1']);
    expect(store[keyA].hiddenFieldIds).not.toContain('field2');
    expect(store[keyA].hiddenFieldIds.length).toBe(1);

    expect(store[keyB].hiddenFieldIds).toEqual(['field2']);
    expect(store[keyB].hiddenFieldIds).not.toContain('field1');
    expect(store[keyB].hiddenFieldIds.length).toBe(1);
  });

  it('new project bucket inherits wildcard hidden set, then diverges', async () => {
    // Set up wildcard bucket with field1 hidden
    await toggleField('*', 'TYPE_A', 'field1', true);

    // First toggle in CSM project — should inherit field1 from wildcard, add field2
    const result = await toggleField('CSM', 'TYPE_A', 'field2', true);

    const wildcardKey = makePrefKey('*', 'TYPE_A');
    const csmKey = makePrefKey('CSM', 'TYPE_A');

    // CSM bucket inherits field1 from wildcard and adds field2
    expect(result[csmKey].hiddenFieldIds).toContain('field1');
    expect(result[csmKey].hiddenFieldIds).toContain('field2');
    expect(result[csmKey].projectKey).toBe('CSM');

    // Wildcard bucket is unchanged
    expect(result[wildcardKey].hiddenFieldIds).toEqual(['field1']);
  });

  it('coerces null projectKey to wildcard', async () => {
    const result = await toggleField(null, 'TYPE_A', 'field1', true);
    const key = makePrefKey('*', 'TYPE_A');
    expect(result[key]).toBeDefined();
    expect(result[key].projectKey).toBe('*');
  });
});

describe('getPref', () => {
  it('returns a fresh default pref for a non-existent issueTypeId without persisting it', async () => {
    const pref = await getPref('*', 'UNKNOWN_TYPE');
    expect(pref).toEqual({ projectKey: '*', issueTypeId: 'UNKNOWN_TYPE', hiddenFieldIds: [] });

    const store = await loadPrefs();
    expect(store[makePrefKey('*', 'UNKNOWN_TYPE')]).toBeUndefined();
  });

  it('returns exact project entry when it exists', async () => {
    await toggleField('CSM', 'TYPE_A', 'field1', true);
    const pref = await getPref('CSM', 'TYPE_A');
    expect(pref.projectKey).toBe('CSM');
    expect(pref.hiddenFieldIds).toContain('field1');
  });

  it('falls back to wildcard entry when no exact entry exists', async () => {
    // Only a wildcard bucket exists
    await toggleField('*', 'TYPE_A', 'fieldW', true);
    // Ask for ITSM project — no exact entry, should fall back to wildcard
    const pref = await getPref('ITSM', 'TYPE_A');
    expect(pref.hiddenFieldIds).toContain('fieldW');
  });

  it('exact entry takes precedence over wildcard', async () => {
    await toggleField('*', 'TYPE_A', 'wildcardField', true);
    // CSM project has diverged — only has exactField
    await toggleField('CSM', 'TYPE_A', 'exactField', true);
    const wildcardKey = makePrefKey('*', 'TYPE_A');
    // But the inherit-then-diverge means CSM also inherits wildcardField
    // Let's test with a clean scenario: write stores directly
    const store = await loadPrefs();
    // Override CSM entry to have only exactField (simulating diverged state)
    await savePrefs({
      ...store,
      [makePrefKey('CSM', 'TYPE_A')]: { projectKey: 'CSM', issueTypeId: 'TYPE_A', hiddenFieldIds: ['exactField'] },
    });

    const pref = await getPref('CSM', 'TYPE_A');
    expect(pref.hiddenFieldIds).toEqual(['exactField']);
    expect(pref.hiddenFieldIds).not.toContain('wildcardField');
  });

  it('coerces null projectKey to wildcard', async () => {
    await toggleField('*', 'TYPE_A', 'field1', true);
    const pref = await getPref(null, 'TYPE_A');
    expect(pref.hiddenFieldIds).toContain('field1');
  });
});

describe('migrateIfNeeded', () => {
  it('returns {} for null', () => {
    expect(migrateIfNeeded(null)).toEqual({});
  });

  it('returns {} for undefined', () => {
    expect(migrateIfNeeded(undefined)).toEqual({});
  });

  it('returns {} for a non-object input (string)', () => {
    expect(migrateIfNeeded('not-an-object')).toEqual({});
  });

  it('passes through already-v2 data (keys contain ":")', () => {
    const input = { '*:TYPE_A': { projectKey: '*', issueTypeId: 'TYPE_A', hiddenFieldIds: ['f1'] } };
    expect(migrateIfNeeded(input)).toBe(input);
  });

  it('migrates v1 data: bare issueTypeId keys → composite *:issueTypeId keys', () => {
    const v1 = {
      incident: { issueTypeId: 'incident', hiddenFieldIds: ['f1', 'f2'] },
      task: { issueTypeId: 'task', hiddenFieldIds: [] },
    };
    const migrated = migrateIfNeeded(v1);
    expect(migrated['*:incident']).toEqual({ projectKey: '*', issueTypeId: 'incident', hiddenFieldIds: ['f1', 'f2'] });
    expect(migrated['*:task']).toEqual({ projectKey: '*', issueTypeId: 'task', hiddenFieldIds: [] });
    expect(migrated['incident']).toBeUndefined();
    expect(migrated['task']).toBeUndefined();
  });
});

describe('migration v1→v2 in loadPrefs', () => {
  it('reads v1 key, migrates to v2, persists under v2 key', async () => {
    // Simulate v1 data stored under the old key
    const v1Data = {
      incident: { issueTypeId: 'incident', hiddenFieldIds: ['summary'] },
    };
    await mockStorage.set({ [PREFS_STORAGE_KEY_V1]: v1Data });

    const store = await loadPrefs();

    // v2 composite key should exist
    expect(store['*:incident']).toEqual({ projectKey: '*', issueTypeId: 'incident', hiddenFieldIds: ['summary'] });

    // Should have been persisted under v2 key
    const raw = mockStorage._raw();
    expect(raw[PREFS_STORAGE_KEY]).toBeDefined();
    expect((raw[PREFS_STORAGE_KEY] as any)['*:incident']).toEqual({
      projectKey: '*', issueTypeId: 'incident', hiddenFieldIds: ['summary'],
    });
  });

  it('v2 key takes precedence over v1 key (idempotent — no double-migration)', async () => {
    const v1Data = { incident: { issueTypeId: 'incident', hiddenFieldIds: ['summary'] } };
    const v2Data = { '*:task': { projectKey: '*', issueTypeId: 'task', hiddenFieldIds: ['desc'] } };
    await mockStorage.set({ [PREFS_STORAGE_KEY_V1]: v1Data, [PREFS_STORAGE_KEY]: v2Data });

    const store = await loadPrefs();

    // v2 data wins — v1 NOT merged
    expect(store['*:task']).toBeDefined();
    expect(store['*:incident']).toBeUndefined();
  });

  it('v1 key is deleted from storage after migration so re-migration never fires', async () => {
    const v1Data = { incident: { issueTypeId: 'incident', hiddenFieldIds: ['summary'] } };
    await mockStorage.set({ [PREFS_STORAGE_KEY_V1]: v1Data });

    await loadPrefs();

    // v1 key must be gone
    expect(mockStorage._raw()[PREFS_STORAGE_KEY_V1]).toBeUndefined();
  });

  it('concurrent v2 write during migration is preserved (merge, not overwrite)', async () => {
    // Simulate v1 data
    const v1Data = {
      incident: { issueTypeId: 'incident', hiddenFieldIds: ['summary'] },
    };
    await mockStorage.set({ [PREFS_STORAGE_KEY_V1]: v1Data });

    // Intercept the second get() call (the merge re-read) to inject a concurrent v2 entry
    // that "another tab" wrote between the initial get and the savePrefs write.
    const originalGet = mockStorage.get.bind(mockStorage);
    let getCallCount = 0;
    mockStorage.get = vi.fn((key: string | string[]) => {
      getCallCount++;
      // First call: the loadPrefs get([v2key, v1key]) — return both
      if (getCallCount === 1) return originalGet(key);
      // Second call: the merge re-read — inject a concurrent v2 entry
      return Promise.resolve({
        [PREFS_STORAGE_KEY]: { '*:task': { projectKey: '*', issueTypeId: 'task', hiddenFieldIds: ['concurrent'] } },
      });
    });

    const store = await loadPrefs();

    // Migrated v1 entry survives
    expect(store['*:incident']).toEqual({ projectKey: '*', issueTypeId: 'incident', hiddenFieldIds: ['summary'] });
    // Concurrent v2 entry wins (not clobbered)
    expect(store['*:task']).toEqual({ projectKey: '*', issueTypeId: 'task', hiddenFieldIds: ['concurrent'] });
    // v1 key must be removed
    expect(mockStorage._raw()[PREFS_STORAGE_KEY_V1]).toBeUndefined();
  });

  it('clearPrefs removes both v1 and v2 keys so subsequent loadPrefs returns {}', async () => {
    const v1Data = { incident: { issueTypeId: 'incident', hiddenFieldIds: ['summary'] } };
    await mockStorage.set({ [PREFS_STORAGE_KEY_V1]: v1Data });
    // Also write a v2 key
    await toggleField('*', 'incident', 'summary', true);

    await clearPrefs();

    const raw = mockStorage._raw();
    expect(raw[PREFS_STORAGE_KEY]).toBeUndefined();
    expect(raw[PREFS_STORAGE_KEY_V1]).toBeUndefined();

    // loadPrefs must return {} without triggering re-migration
    const store = await loadPrefs();
    expect(store).toEqual({});
  });
});

describe('clearPref', () => {
  it('removes only the specified composite entry', async () => {
    await toggleField('*', 'TYPE_A', 'field1', true);
    await toggleField('*', 'TYPE_B', 'field2', true);

    await clearPref('*', 'TYPE_A');

    const store = await loadPrefs();
    expect(store[makePrefKey('*', 'TYPE_A')]).toBeUndefined();
    expect(store[makePrefKey('*', 'TYPE_B')]).toBeDefined();
  });

  it('is a no-op when the entry does not exist', async () => {
    await toggleField('*', 'TYPE_A', 'field1', true);
    await clearPref('CSM', 'TYPE_A'); // CSM entry doesn't exist

    const store = await loadPrefs();
    expect(store[makePrefKey('*', 'TYPE_A')]).toBeDefined(); // unaffected
  });

  it('coerces null projectKey to wildcard', async () => {
    await toggleField('*', 'TYPE_A', 'field1', true);
    await clearPref(null, 'TYPE_A');

    const store = await loadPrefs();
    expect(store[makePrefKey('*', 'TYPE_A')]).toBeUndefined();
  });
});

describe('loadPrefs / savePrefs', () => {
  it('round-trips a store through savePrefs and loadPrefs', async () => {
    const store = {
      '*:TYPE_A': { projectKey: '*', issueTypeId: 'TYPE_A', hiddenFieldIds: ['f1', 'f2'] },
    };
    await savePrefs(store);
    const loaded = await loadPrefs();
    expect(loaded).toEqual(store);
    expect(mockStorage._raw()[PREFS_STORAGE_KEY]).toEqual(store);
  });

  it('returns {} when nothing has been saved yet', async () => {
    const loaded = await loadPrefs();
    expect(loaded).toEqual({});
  });
});
