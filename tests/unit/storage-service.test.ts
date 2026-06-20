import { describe, it, expect, beforeEach, vi } from 'vitest';

function createMockChromeStorage() {
  let store: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => {
      return Promise.resolve(key in store ? { [key]: store[key] } : {});
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      store = { ...store, ...items };
      return Promise.resolve();
    }),
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
  migrateIfNeeded,
} from '../../src/lib/storage-service';
import { PREFS_STORAGE_KEY } from '../../src/types/prefs';

describe('toggleField', () => {
  it('adds fieldId to a fresh issueTypeId hiddenFieldIds when hidden: true', async () => {
    const result = await toggleField('TYPE_A', 'field1', true);
    expect(result['TYPE_A'].hiddenFieldIds).toEqual(['field1']);
    expect(result['TYPE_A'].issueTypeId).toBe('TYPE_A');
  });

  it('removes fieldId from hiddenFieldIds when hidden: false on an already-hidden field', async () => {
    await toggleField('TYPE_A', 'field1', true);
    const result = await toggleField('TYPE_A', 'field1', false);
    expect(result['TYPE_A'].hiddenFieldIds).toEqual([]);
  });

  it('does not duplicate fieldId when toggled hidden: true twice in a row', async () => {
    await toggleField('TYPE_A', 'field1', true);
    const result = await toggleField('TYPE_A', 'field1', true);
    expect(result['TYPE_A'].hiddenFieldIds).toEqual(['field1']);
    expect(result['TYPE_A'].hiddenFieldIds.length).toBe(1);
  });

  it('keeps per-issueTypeId state isolated (critical invariant)', async () => {
    await toggleField('TYPE_A', 'field1', true);
    await toggleField('TYPE_B', 'field2', true);

    const store = await loadPrefs();

    expect(store['TYPE_A'].hiddenFieldIds).toEqual(['field1']);
    expect(store['TYPE_A'].hiddenFieldIds).not.toContain('field2');
    expect(store['TYPE_A'].hiddenFieldIds.length).toBe(1);

    expect(store['TYPE_B'].hiddenFieldIds).toEqual(['field2']);
    expect(store['TYPE_B'].hiddenFieldIds).not.toContain('field1');
    expect(store['TYPE_B'].hiddenFieldIds.length).toBe(1);
  });
});

describe('getPref', () => {
  it('returns a fresh default pref for a non-existent issueTypeId without persisting it', async () => {
    const pref = await getPref('UNKNOWN_TYPE');
    expect(pref).toEqual({ issueTypeId: 'UNKNOWN_TYPE', hiddenFieldIds: [] });

    const store = await loadPrefs();
    expect(store['UNKNOWN_TYPE']).toBeUndefined();
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

  it('returns the input as-is when given a valid-looking object', () => {
    const input = { TYPE_A: { issueTypeId: 'TYPE_A', hiddenFieldIds: ['f1'] } };
    expect(migrateIfNeeded(input)).toBe(input);
  });
});

describe('loadPrefs / savePrefs', () => {
  it('round-trips a store through savePrefs and loadPrefs', async () => {
    const store = {
      TYPE_A: { issueTypeId: 'TYPE_A', hiddenFieldIds: ['f1', 'f2'] },
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
