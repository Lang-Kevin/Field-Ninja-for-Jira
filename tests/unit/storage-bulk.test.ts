import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  writeBuckets,
  mergeActivations,
  listKnownBuckets,
  buildExport,
  toggleField,
  StorageQuotaError,
} from '../../src/lib/storage-service';
import { validateExport } from '../../src/lib/export-schema';
import {
  ACTIVATIONS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  makeShardKey,
  fieldLabelKey,
  tabCacheKey,
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
  sync = area();
  local = area();
  (globalThis as any).chrome = {
    storage: { sync, local, onChanged: { addListener: () => {}, removeListener: () => {} } },
  };
});

const b = (host: string, projectKey: string, issueTypeId: string, hiddenFieldIds: string[]) => ({
  host,
  projectKey,
  issueTypeId,
  hiddenFieldIds,
});
const ids = (n: number) => Array.from({ length: n }, (_, i) => `customfield_${String(i).padStart(5, '0')}`);

describe('writeBuckets', () => {
  it('replace: file wins per bucket, other buckets and shards are kept, one set', async () => {
    sync.seed({ [makeShardKey(H, P)]: { story: ['a'], bug: ['b'] } });
    await writeBuckets([b(H, P, 'story', ['x', 'x', 'y']), b('other.atlassian.net', 'DEV', 'task', ['t'])], 'replace');
    expect(sync.raw()).toEqual({
      [makeShardKey(H, P)]: { story: ['x', 'y'], bug: ['b'] },
      [makeShardKey('other.atlassian.net', 'DEV')]: { task: ['t'] },
    });
    expect(sync.set).toHaveBeenCalledTimes(1);
  });

  // RF-5
  it("union keeps the target's existing ids", async () => {
    sync.seed({ [makeShardKey(H, P)]: { story: ['a', 'keep'] } });
    await writeBuckets([b(H, P, 'story', ['a', 'b'])], 'union');
    expect(sync.raw()[makeShardKey(H, P)]).toEqual({ story: ['a', 'keep', 'b'] });
  });

  it('skips unwritable scopes (HR-6) and empty lists — nothing to write, no set', async () => {
    await writeBuckets(
      [b('', P, 'story', ['f']), b(H, '', 'story', ['f']), b(H, P, 'unknown', ['f']), b(H, P, 'story', [])],
      'replace'
    );
    expect(sync.set).not.toHaveBeenCalled();
    expect(sync.raw()).toEqual({});
  });

  // RF-2
  it('item precheck aborts whole batch', async () => {
    const err = await writeBuckets([b(H, 'OK', 'story', ['f1']), b(H, P, 'bug', ids(500))], 'replace').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageQuotaError);
    expect(err).toMatchObject({ kind: 'item', scope: `${H}:${P}` });
    expect(sync.set).not.toHaveBeenCalled();
    expect(sync.raw()).toEqual({});
  });

  it('total precheck aborts before any write', async () => {
    // 12 × ~8 KB filler ≈ 96.0 KB; two new ~4.1 KB shards → ~104.2 KB > 100 KB, each shard < 8 KB.
    sync.seed(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, 'x'.repeat(8000)])));
    await expect(
      writeBuckets([b(H, 'A', 'story', ids(200)), b(H, 'B', 'story', ids(200))], 'replace')
    ).rejects.toMatchObject({ kind: 'total', limit: 102400 });
    expect(sync.set).not.toHaveBeenCalled();
  });

  // RF-4
  it('writeBuckets and toggleField on the same shard serialize', async () => {
    await Promise.all([
      writeBuckets([b(H, P, 'story', ['a'])], 'replace'),
      toggleField(H, P, 'bug', 'b', true),
      writeBuckets([b(H, P, 'task', ['c'])], 'union'),
    ]);
    expect(sync.raw()[makeShardKey(H, P)]).toEqual({ story: ['a'], bug: ['b'], task: ['c'] });
  });
});

describe('mergeActivations', () => {
  it('unions valid scopes into the activations item with one set, skips malformed ones', async () => {
    sync.seed({ [ACTIVATIONS_STORAGE_KEY]: { 'a.atlassian.net:A': true } });
    await mergeActivations(['b.atlassian.net:B', 'a.atlassian.net:A', 'bad', 'x:y:z']);
    expect(sync.raw()[ACTIVATIONS_STORAGE_KEY]).toEqual({ 'a.atlassian.net:A': true, 'b.atlassian.net:B': true });
    expect(sync.set).toHaveBeenCalledTimes(1);
  });

  it('no valid scope → no write', async () => {
    await mergeActivations(['bad']);
    expect(sync.set).not.toHaveBeenCalled();
  });
});

describe('listKnownBuckets', () => {
  it('v4 buckets ∪ label-cache buckets, known types only, deduped, sorted', async () => {
    sync.seed({
      [makeShardKey(H, P)]: { story: ['a'] },
      [makeShardKey('b.atlassian.net', 'DEV')]: { bug: ['x'] },
    });
    local.seed({
      [fieldLabelKey(H, P, 'story')]: {}, // duplicate of the shard bucket
      [fieldLabelKey(H, P, 'task')]: {},
      [fieldLabelKey(H, P, 'unknown')]: {},
      [tabCacheKey('c.atlassian.net', 'C', 'story')]: {}, // not a label cache → ignored
      'jfv-field-labels:v1:old.atlassian.net:X:story': {}, // legacy → ignored
    });
    expect(await listKnownBuckets()).toEqual([
      { host: H, projectKey: P, issueTypeId: 'story' },
      { host: H, projectKey: P, issueTypeId: 'task' },
      { host: 'b.atlassian.net', projectKey: 'DEV', issueTypeId: 'bug' },
    ]);
  });
});

describe('buildExport', () => {
  it('round-trips through validateExport: shards, activations, exactly the 4 settings keys', async () => {
    sync.seed({
      [makeShardKey(H, P)]: { story: ['a'] },
      [makeShardKey(H, 'EMPTY')]: {},
      [ACTIVATIONS_STORAGE_KEY]: { [`${H}:${P}`]: true },
      [SETTINGS_STORAGE_KEY]: { showFieldButtons: false, debugOutline: true, shrinkCover: true, coverHeightPx: 120, stale: 1 },
    });
    const r = validateExport(JSON.parse(JSON.stringify(await buildExport())));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.prefs).toEqual({ [`${H}:${P}`]: { story: ['a'] } });
    expect(r.data.activations).toEqual([`${H}:${P}`]);
    expect(r.data.settings).toEqual({ showFieldButtons: false, debugOutline: true, shrinkCover: true, coverHeightPx: 120 });
    expect(typeof r.data.exportedAt).toBe('string');
  });
});
