import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrateV3ToV4, pruneLocalCaches, StorageQuotaError } from '../../src/lib/storage-service';
import {
  PREFS_V3_STORAGE_KEY as V3,
  ACTIVATIONS_STORAGE_KEY,
  makePrefKey,
  makeShardKey,
  fieldLabelKey,
  tabCacheKey,
  sectionCacheKey,
} from '../../src/types/prefs';

const H = 'acme.atlassian.net';
const P = 'PROJ';

function area() {
  let store: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string | null) => (key === null ? { ...store } : key in store ? { [key]: store[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      store = { ...store, ...items };
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of [keys].flat()) delete store[k];
    }),
    seed: (items: Record<string, unknown>) => {
      store = { ...store, ...items };
    },
    raw: () => store,
  };
}

let sync: ReturnType<typeof area>;
let local: ReturnType<typeof area>;

beforeEach(() => {
  vi.restoreAllMocks(); // no restoreMocks in vitest.config — reset the console spy per test
  sync = area();
  local = area();
  (globalThis as any).chrome = {
    storage: { sync, local, onChanged: { addListener: () => {}, removeListener: () => {} } },
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const v3e = (host: string, projectKey: string, issueTypeId: string, hiddenFieldIds: string[]) => ({
  [makePrefKey(host, projectKey, issueTypeId)]: { host, projectKey, issueTypeId, hiddenFieldIds },
});

const ids = (n: number) => Array.from({ length: n }, (_, i) => `customfield_${String(i).padStart(5, '0')}`);

describe('migrateV3ToV4', () => {
  it('no v3 key → {0,0}, no write', async () => {
    sync.seed({ [makeShardKey(H, P)]: { story: ['a'] } });
    expect(await migrateV3ToV4()).toEqual({ migrated: 0, skipped: 0 });
    expect(sync.set).not.toHaveBeenCalled();
    expect(sync.remove).not.toHaveBeenCalled();
  });

  it('v3 that is not a plain object → {0,0}, left untouched', async () => {
    sync.seed({ [V3]: ['x'] });
    expect(await migrateV3ToV4()).toEqual({ migrated: 0, skipped: 0 });
    expect(sync.raw()[V3]).toEqual(['x']);
  });

  it('moves every bucket into its scope shard (deduped, value fields trusted over the key), one set, then remove(v3)', async () => {
    sync.seed({
      [V3]: {
        ...v3e(H, P, 'story', ['f1', 'f1', 'f2']),
        ...v3e(H, P, 'bug', ['f3']),
        ...v3e(H, P, 'task', []),
        'wrong:KEY:epic': { host: 'b.atlassian.net', projectKey: 'DEV', issueTypeId: 'epic', hiddenFieldIds: ['f4'] },
      },
    });
    expect(await migrateV3ToV4()).toEqual({ migrated: 3, skipped: 0 });
    expect(sync.raw()).toEqual({
      [makeShardKey(H, P)]: { story: ['f1', 'f2'], bug: ['f3'] },
      [makeShardKey('b.atlassian.net', 'DEV')]: { epic: ['f4'] },
    });
    expect(sync.set).toHaveBeenCalledTimes(1);
    expect(sync.remove).toHaveBeenCalledWith(V3);
    expect(sync.set.mock.invocationCallOrder[0]).toBeLessThan(sync.remove.mock.invocationCallOrder[0]);
  });

  // RF-1
  it('v3 and v4 both present: v4 wins per type, v3 types fill gaps, v3 removed', async () => {
    sync.seed({
      [makeShardKey(H, P)]: { story: ['new'], task: ['t1'] },
      [V3]: { ...v3e(H, P, 'story', ['old']), ...v3e(H, P, 'bug', ['b1']) },
    });
    expect(await migrateV3ToV4()).toEqual({ migrated: 1, skipped: 0 });
    expect(sync.raw()).toEqual({ [makeShardKey(H, P)]: { story: ['new'], task: ['t1'], bug: ['b1'] } });
  });

  // RF-1
  it('remove throws → rerun is clean', async () => {
    sync.seed({ [V3]: v3e(H, P, 'story', ['f1']) });
    sync.remove.mockRejectedValueOnce(new Error('IO'));
    await expect(migrateV3ToV4()).rejects.toThrow('IO');
    expect(sync.raw()[makeShardKey(H, P)]).toEqual({ story: ['f1'] });
    expect(sync.raw()[V3]).toBeDefined();

    expect(await migrateV3ToV4()).toEqual({ migrated: 0, skipped: 0 });
    expect(sync.raw()).toEqual({ [makeShardKey(H, P)]: { story: ['f1'] } });
    expect(sync.set).toHaveBeenCalledTimes(1); // rerun copies nothing, only removes v3
  });

  it('set throws → v3 intact, nothing removed', async () => {
    sync.seed({ [V3]: v3e(H, P, 'story', ['f1']) });
    sync.set.mockRejectedValueOnce(new Error('IO'));
    await expect(migrateV3ToV4()).rejects.toThrow('IO');
    expect(sync.remove).not.toHaveBeenCalled();
    expect(sync.raw()).toEqual({ [V3]: v3e(H, P, 'story', ['f1']) });
  });

  it('malformed entries are skipped and logged, valid ones still migrate', async () => {
    sync.seed({
      [V3]: {
        ...v3e(H, P, 'story', ['f1']),
        k1: { host: '', projectKey: P, issueTypeId: 'story', hiddenFieldIds: ['x'] },
        k2: { host: H, projectKey: 5, issueTypeId: 'story', hiddenFieldIds: ['x'] },
        k3: { host: H, projectKey: P, issueTypeId: 'unknown', hiddenFieldIds: ['x'] },
        k4: { host: H, projectKey: P, issueTypeId: 'bug', hiddenFieldIds: 'x' },
        k5: { host: H, projectKey: P, issueTypeId: 'bug', hiddenFieldIds: [1] },
        k6: null,
      },
    });
    expect(await migrateV3ToV4()).toEqual({ migrated: 1, skipped: 6 });
    expect(sync.raw()).toEqual({ [makeShardKey(H, P)]: { story: ['f1'] } });
    expect(console.warn).toHaveBeenCalledTimes(6);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[jfv]'));
  });

  // RF-2
  it('overflow → throws, no write, v3 kept', async () => {
    sync.seed({ [V3]: v3e(H, P, 'story', ids(500)) });
    const err = await migrateV3ToV4().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageQuotaError);
    expect(err).toMatchObject({ kind: 'item', scope: `${H}:${P}` });
    expect(sync.set).not.toHaveBeenCalled();
    expect(sync.remove).not.toHaveBeenCalled();
    expect(sync.raw()[V3]).toBeDefined();
  });

  it('total overflow at set time (v3 still present) → throws "total", no write', async () => {
    // 12 × ~8 KB filler ≈ 96.0 KB + v3 (~4.1 KB) = ~100.2 KB fits; + new shard (~4.1 KB) = ~104.3 KB > 100 KB.
    const filler = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, 'x'.repeat(8000)]));
    sync.seed({ ...filler, [V3]: v3e(H, P, 'story', ids(200)) });
    await expect(migrateV3ToV4()).rejects.toMatchObject({ kind: 'total', limit: 102400 });
    expect(sync.set).not.toHaveBeenCalled();
    expect(sync.raw()[V3]).toBeDefined();
  });

  it('is idempotent: a second run is a no-op', async () => {
    sync.seed({ [V3]: v3e(H, P, 'story', ['f1']) });
    await migrateV3ToV4();
    expect(await migrateV3ToV4()).toEqual({ migrated: 0, skipped: 0 });
    expect(sync.set).toHaveBeenCalledTimes(1);
    expect(sync.remove).toHaveBeenCalledTimes(1);
  });
});

describe('pruneLocalCaches', () => {
  it('is a no-op while v3 still exists (migration pending)', async () => {
    sync.seed({ [V3]: {} });
    local.seed({ [fieldLabelKey('dead.atlassian.net', 'DEAD', 'story')]: {} });
    await pruneLocalCaches();
    expect(local.remove).not.toHaveBeenCalled();
    expect(Object.keys(local.raw())).toHaveLength(1);
  });

  it('drops caches of scopes with no non-empty shard and no activation, keeps everything else', async () => {
    sync.seed({
      [makeShardKey(H, P)]: { story: ['f1'] },
      [makeShardKey(H, 'EMPTY')]: {},
      [ACTIVATIONS_STORAGE_KEY]: { 'act.atlassian.net:ACT': true },
    });
    const kept = [
      fieldLabelKey(H, P, 'story'),
      tabCacheKey(H, P, 'bug'),
      sectionCacheKey('act.atlassian.net', 'ACT', 'story'),
      'jfv-field-labels:v1:old.atlassian.net:X:story', // legacy: dropLegacyPrefs' job, not ours
      'unrelated',
    ];
    const stale = [fieldLabelKey('dead.atlassian.net', 'DEAD', 'story'), tabCacheKey(H, 'EMPTY', 'story')];
    local.seed(Object.fromEntries([...kept, ...stale].map((k) => [k, {}])));
    await pruneLocalCaches();
    expect(Object.keys(local.raw()).sort()).toEqual([...kept].sort());
    expect(local.remove).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows a local.remove failure', async () => {
    local.seed({ [fieldLabelKey('dead.atlassian.net', 'DEAD', 'story')]: {} });
    local.remove.mockRejectedValueOnce(new Error('IO'));
    await expect(pruneLocalCaches()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[jfv]'), expect.any(Error));
  });
});
