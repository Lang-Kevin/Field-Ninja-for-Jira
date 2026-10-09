import type { ActivationStore, Pref, PrefShard, PrefsStore, Settings } from '../types/prefs';
import {
  ACTIVATIONS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  DEFAULT_SETTINGS,
  LEGACY_PREFS_KEYS,
  LOCAL_CACHE_PREFIXES,
  PREFS_V4_PREFIX,
  PREFS_V3_STORAGE_KEY,
  SYNC_QUOTA,
  makePrefKey,
  makeScopeKey,
  makeShardKey,
  parseScopeKey,
  parseShardKey,
  scopeOfLocalCacheKey,
  fieldLabelKey,
} from '../types/prefs';
import { isKnownIssueType } from './jira-context-resolver';
import { EXPORT_FORMAT, type ExportFileV1 } from './export-schema';

/**
 * Single gateway to chrome.storage.sync for this extension.
 * All reads/writes of prefs MUST go through this module.
 *
 * getWriteSeqStatus is the one exception to "reads/writes only": it exposes
 * write-scheduling metadata (not prefs data) so content-entry.ts can detect
 * whether one of ITS OWN toggleField calls is still in flight before trusting
 * an incoming chrome.storage.onChanged snapshot. It only tracks writes issued
 * via this module's own toggleField — not writes from other contexts/tabs —
 * so it isn't a general "is storage settled" signal and shouldn't be reused
 * as one elsewhere (e.g. the options page) without re-checking that scoping.
 *
 * Storage layout (v4): one sync item per host+project
 * (`jiraFieldVisibility:v4:<host>:<PROJ>`), each capped at
 * QUOTA_BYTES_PER_ITEM (8KB). writeShard prechecks it and throws
 * StorageQuotaError instead of letting the browser reject the write.
 *
 * loadPrefs() assembles the legacy-shaped PrefsStore from all shards, so
 * callers are unchanged. Every sync set/remove goes through syncSet/syncRemove,
 * which rethrow browser quota errors as StorageQuotaError.
 */

export class StorageQuotaError extends Error {
  constructor(
    public kind: 'item' | 'total' | 'rate',
    public scope?: string,
    public bytes?: number,
    public limit?: number
  ) {
    super(`[jfv] sync quota exceeded: ${kind}${scope ? ` (${scope})` : ''}${bytes !== undefined ? ` ${bytes}B > ${limit}B` : ''}`);
    this.name = 'StorageQuotaError';
  }
}

const kb = (n: number): number => +(n / 1024).toFixed(1);

/** Single source of user-facing quota text; null for non-quota errors. */
export function quotaMessage(e: unknown): string | null {
  if (!(e instanceof StorageQuotaError)) return null;
  if (e.kind === 'rate') return 'Too many changes per minute — try again shortly';
  if (e.kind === 'total') return `Sync storage full (${kb(e.limit ?? SYNC_QUOTA.total)} KB)`;
  const scope = e.scope ? parseScopeKey(e.scope) : null;
  const who = scope ? `${scope.projectKey} on ${scope.host}` : 'This project';
  const limit = kb(e.limit ?? SYNC_QUOTA.perItem);
  const size = e.bytes !== undefined ? `${kb(e.bytes)} KB > ${limit} KB` : `${limit} KB`;
  return `${who} has too many hidden fields (${size} per project)`;
}

const utf8 = (s: string): number => new TextEncoder().encode(s).length;

/** Chrome's per-item formula: utf8(key) + utf8(JSON(value)). */
function itemBytes(key: string, value: unknown): number {
  return utf8(key) + utf8(JSON.stringify(value));
}

function usageOf(all: Record<string, unknown>): number {
  return Object.entries(all).reduce((n, [k, v]) => n + itemBytes(k, v), 0);
}

/** Throws StorageQuotaError('item') before the browser ever sees an oversized shard. */
function checkItem(key: string, value: unknown): void {
  const bytes = itemBytes(key, value);
  if (bytes > SYNC_QUOTA.perItem) {
    throw new StorageQuotaError('item', key.slice(PREFS_V4_PREFIX.length), bytes, SYNC_QUOTA.perItem);
  }
}

// Order matters: "QUOTA_BYTES_PER_ITEM" contains "QUOTA_BYTES", and Chrome's rate
// messages contain "quota". Firefox throws a generic QuotaExceededError.
function toQuotaError(e: unknown): unknown {
  const err = e as { name?: unknown; message?: unknown } | null;
  const msg = `${String(err?.name ?? '')} ${String(err?.message ?? e)}`;
  if (/QUOTA_BYTES_PER_ITEM/.test(msg)) return new StorageQuotaError('item');
  if (/MAX_(SUSTAINED_)?WRITE_OPERATIONS/.test(msg)) return new StorageQuotaError('rate');
  if (/QUOTA_BYTES|quota/i.test(msg)) return new StorageQuotaError('total');
  return e;
}

async function syncSet(items: Record<string, unknown>): Promise<void> {
  try {
    await chrome.storage.sync.set(items);
  } catch (e) {
    throw toQuotaError(e);
  }
}

async function syncRemove(keys: string | string[]): Promise<void> {
  try {
    await chrome.storage.sync.remove(keys);
  } catch (e) {
    throw toQuotaError(e);
  }
}

/** Own-property read: an issue-type slug like 'constructor' must not hit Object.prototype. */
function idsOf(shard: PrefShard, issueTypeId: string): string[] {
  return Object.hasOwn(shard, issueTypeId) ? shard[issueTypeId] : [];
}

/** Reads exactly one shard; returns a mutable copy ({} when missing). */
async function readShard(host: string, projectKey: string): Promise<PrefShard> {
  const key = makeShardKey(host, projectKey);
  const res = await chrome.storage.sync.get(key);
  return { ...((res[key] as PrefShard | undefined) ?? {}) };
}

/** Empty shard → remove the item; otherwise per-item precheck, then one set. */
async function writeShard(host: string, projectKey: string, shard: PrefShard): Promise<void> {
  const key = makeShardKey(host, projectKey);
  if (Object.keys(shard).length === 0) {
    await syncRemove(key);
    return;
  }
  checkItem(key, shard);
  await syncSet({ [key]: shard });
}

/** v4 shards inside a full `sync.get(null)` result → legacy-shaped PrefsStore. */
function expandShards(all: Record<string, unknown>): PrefsStore {
  const store: PrefsStore = {};
  for (const [key, value] of Object.entries(all)) {
    const scope = parseShardKey(key);
    if (!scope) continue;
    for (const [issueTypeId, hiddenFieldIds] of Object.entries(value as PrefShard)) {
      store[makePrefKey(scope.host, scope.projectKey, issueTypeId)] = { ...scope, issueTypeId, hiddenFieldIds };
    }
  }
  return store;
}

export async function loadPrefs(): Promise<PrefsStore> {
  return expandShards(await chrome.storage.sync.get(null));
}

/** Sync bytes in use (own count, Chrome's formula) — no getBytesInUse, Firefox support unverified. */
export async function getSyncUsage(): Promise<{ bytes: number; quota: number }> {
  return { bytes: usageOf(await chrome.storage.sync.get(null)), quota: SYNC_QUOTA.total };
}

/**
 * Returns the pref for a host+project+issueType combo. Reads exactly one
 * shard. A null projectKey never matches a stored pref.
 */
export async function getPref(
  host: string,
  projectKey: string | null,
  issueTypeId: string
): Promise<Pref> {
  if (projectKey === null) {
    return { host, projectKey: '', issueTypeId, hiddenFieldIds: [] };
  }
  const shard = await readShard(host, projectKey);
  return { host, projectKey, issueTypeId, hiddenFieldIds: idsOf(shard, issueTypeId) };
}

/** Removes every v4 shard. Activations and settings stay (HR-16). */
export function clearPrefs(): Promise<void> {
  return enqueueWrite(async () => {
    const all = await chrome.storage.sync.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFS_V4_PREFIX));
    if (keys.length > 0) await syncRemove(keys);
  });
}

/** Deletes one host+project+issueType bucket; serialized with every other prefs write (HR-4). */
export function clearPref(
  host: string,
  projectKey: string | null,
  issueTypeId: string
): Promise<void> {
  return enqueueWrite(async () => {
    if (!host || !projectKey) return;
    const shard = await readShard(host, projectKey);
    if (!Object.hasOwn(shard, issueTypeId)) return;
    delete shard[issueTypeId];
    await writeShard(host, projectKey, shard);
  });
}

/**
 * Fires when any v4 shard changes in sync — writes from ANY context, including
 * this one. No snapshot is passed: content-entry.ts re-reads via getPref.
 * Returns an unsubscribe function.
 */
export function onPrefsChanged(cb: () => void): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ): void => {
    if (areaName !== 'sync' || !Object.keys(changes).some((k) => k.startsWith(PREFS_V4_PREFIX))) {
      return;
    }
    cb();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_STORAGE_KEY] as Partial<Settings> | undefined) };
}

// ponytail: settings-only serialization chain, separate from writeQueue.
// writeQueue's issuedWriteSeq/committedWriteSeq are documented as tracking
// this module's own toggleField/setHiddenFields calls specifically (for
// content-entry.ts's stale-onChanged detection on the PREFS key) — folding
// unrelated settings writes into those counters would pollute that meaning.
// This chain exists solely to stop concurrent saveSettings calls from
// interleaving their read-modify-write and clobbering each other.
let settingsWriteChain: Promise<unknown> = Promise.resolve();

export function saveSettings(settings: Partial<Settings>): Promise<void> {
  const result = settingsWriteChain.then(async () => {
    const current = await loadSettings();
    await syncSet({ [SETTINGS_STORAGE_KEY]: { ...current, ...settings } });
  });
  settingsWriteChain = result.catch(() => undefined);
  return result;
}

/** Mirrors onPrefsChanged but for the separate settings key. */
export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ): void => {
    if (areaName !== 'sync' || !(SETTINGS_STORAGE_KEY in changes)) {
      return;
    }
    cb({ ...DEFAULT_SETTINGS, ...(changes[SETTINGS_STORAGE_KEY].newValue as Partial<Settings> | undefined) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ponytail: single shared write guard — a write with an empty host or a
// null/missing project key must never reach savePrefs, since that would
// produce a malformed composite key. Collapses the two isKnownIssueType-only
// guards that used to live separately in doToggleField/doSetHiddenFields.
function isWritableScope(host: string, projectKey: string | null, issueTypeId: string): boolean {
  return !!host && !!projectKey && isKnownIssueType(issueTypeId);
}

async function doToggleField(
  host: string,
  projectKey: string | null,
  issueTypeId: string,
  fieldId: string,
  hidden: boolean
): Promise<PrefsStore> {
  // ponytail: guard at the single storage gateway rather than every caller,
  // so an 'unknown' issueTypeId (resolved-context not yet ready) can never
  // create a bogus PrefsStore bucket, no matter who calls toggleField.
  if (!isWritableScope(host, projectKey, issueTypeId)) {
    return loadPrefs();
  }
  const shard = await readShard(host, projectKey as string);
  const hiddenSet = new Set(idsOf(shard, issueTypeId));
  if (hidden) {
    hiddenSet.add(fieldId);
  } else {
    hiddenSet.delete(fieldId);
  }
  if (hiddenSet.size > 0) {
    shard[issueTypeId] = [...hiddenSet];
  } else {
    delete shard[issueTypeId];
  }
  await writeShard(host, projectKey as string, shard);
  return loadPrefs();
}

// Serializes toggleField calls so a rapid sequence's read-modify-write steps
// never interleave: without this, call B's loadPrefs() can read before call
// A's savePrefs() commits, so B computes its update from a stale base and
// can overwrite A's write when it saves. ui-overlay.ts calls toggleField as
// fire-and-forget (never awaited) specifically so a slow write can't block
// the next click's DOM update, which is what makes this race reachable.
let writeQueue: Promise<unknown> = Promise.resolve();

// Monotonic write-sequence counters, used by content-entry.ts to detect a
// chrome.storage.onChanged event that is stale relative to the caller's own
// in-flight local writes. issuedWriteSeq increments synchronously the moment
// toggleField is CALLED (i.e. queued); committedWriteSeq increments once
// that write's savePrefs has actually resolved. When they're equal, every
// locally-issued write has committed and an incoming onChanged snapshot can
// be trusted; when issued > committed, a newer local write is still in
// flight and an onChanged event landing in that window reflects an older,
// since-superseded write — applying it would clobber the UI with stale
// state (see content-entry.ts's onPrefsChanged for the consuming side).
let issuedWriteSeq = 0;
let committedWriteSeq = 0;

export function getWriteSeqStatus(): { issued: number; committed: number } {
  return { issued: issuedWriteSeq, committed: committedWriteSeq };
}

// An onChanged event arriving while issued !== committed is stale and must
// not be applied directly — but committedWriteSeq (incremented via a local
// Promise .finally()) and the onChanged broadcast (a separate browser IPC
// round-trip) have no guaranteed relative ordering. If every event in a
// rapid burst happens to arrive a tick before its own commit's .finally(),
// every one gets gated out and — since no further write follows the last
// click — nothing ever re-renders the true final state. Callers that hit a
// stale gate should await this instead of just dropping the event, then
// re-read prefs directly: it resolves once the queue, including any writes
// issued after the await started (hence the loop), has actually drained.
export async function waitForWritesToSettle(): Promise<void> {
  while (issuedWriteSeq !== committedWriteSeq) {
    await writeQueue;
  }
}

/**
 * Reads the opportunistic fieldId→label cache for one combo. This cache
 * lives in chrome.storage.local (not .sync, where the rest of this module's
 * prefs live) — it's written by content-entry.ts as a best-effort lookup aid,
 * never authoritative. Best-effort; missing → {}.
 */
export async function loadFieldLabels(host: string, projectKey: string, issueTypeId: string):
  Promise<Record<string, string>> {
  const key = fieldLabelKey(host, projectKey, issueTypeId);
  try {
    const res = await chrome.storage.local.get(key);
    return (res[key] as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

// Runs `fn` serialized after every prior queued write, converging
// issuedWriteSeq/committedWriteSeq exactly like toggleField did inline —
// shared by toggleField and setHiddenFields so both write paths are
// serialized against each other in the same execution context.
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  issuedWriteSeq += 1;
  const result = writeQueue.then(fn);
  writeQueue = result.catch(() => undefined);
  // result's own rejection reaches the caller; the .finally()-derived promise
  // would re-reject unhandled, so it gets a no-op catch. It only exists to
  // re-converge committedWriteSeq on both success and failure.
  result
    .finally(() => {
      committedWriteSeq += 1;
    })
    .catch(() => undefined);
  return result;
}

/**
 * Sets the whole hidden-field list for one project+issueType combo in a
 * single shard write. Empty list clears the bucket via clearPref (which
 * enqueues itself — never call it from inside enqueueWrite).
 */
export async function setHiddenFields(
  host: string,
  projectKey: string | null,
  issueTypeId: string,
  fieldIds: string[]
): Promise<void> {
  const deduped = [...new Set(fieldIds)];
  if (deduped.length === 0) {
    await clearPref(host, projectKey, issueTypeId);
    return;
  }
  await enqueueWrite(async () => {
    // Same gateway guard as doToggleField (HR-6).
    if (!isWritableScope(host, projectKey, issueTypeId)) return;
    const shard = await readShard(host, projectKey as string);
    shard[issueTypeId] = deduped;
    await writeShard(host, projectKey as string, shard);
  });
}

export function toggleField(
  host: string,
  projectKey: string | null,
  issueTypeId: string,
  fieldId: string,
  hidden: boolean
): Promise<PrefsStore> {
  return enqueueWrite(() => doToggleField(host, projectKey, issueTypeId, fieldId, hidden));
}

let activationsWriteChain: Promise<unknown> = Promise.resolve();

export async function loadActivations(): Promise<ActivationStore> {
  const result = await chrome.storage.sync.get(ACTIVATIONS_STORAGE_KEY);
  return (result[ACTIVATIONS_STORAGE_KEY] as ActivationStore | undefined) ?? {};
}

export async function isActivated(host: string, projectKey: string | null): Promise<boolean> {
  if (!projectKey) return false;
  const store = await loadActivations();
  return store[makeScopeKey(host, projectKey)] === true;
}

// ponytail: separate serialization chain from writeQueue's
// issuedWriteSeq/committedWriteSeq — those counters exist solely so
// content-entry.ts can detect a stale onChanged event relative to its own
// rapid-fire toggleField/setHiddenFields calls on the PREFS key. Activations
// only ever come from the popup, are never rapid-fire, and live on a
// different storage key entirely — hanging them on that chain would let an
// in-flight field toggle swallow an activation re-render.
export function setActivated(host: string, projectKey: string, active: boolean): Promise<void> {
  if (!host || !projectKey) return Promise.resolve();
  const result = activationsWriteChain.then(async () => {
    const store = await loadActivations();
    const key = makeScopeKey(host, projectKey);
    const updated = { ...store };
    if (active) {
      updated[key] = true;
    } else {
      delete updated[key];
    }
    await syncSet({ [ACTIVATIONS_STORAGE_KEY]: updated });
  });
  activationsWriteChain = result.catch(() => undefined);
  return result;
}

/** Mirrors onPrefsChanged but for the separate activations key. */
export function onActivationsChanged(cb: (store: ActivationStore) => void): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ): void => {
    if (areaName !== 'sync' || !(ACTIVATIONS_STORAGE_KEY in changes)) {
      return;
    }
    cb((changes[ACTIVATIONS_STORAGE_KEY].newValue as ActivationStore | undefined) ?? {});
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

const LEGACY_LOCAL_KEY_PREFIXES = [
  'jfv-field-labels:v1:',
  'jfv-tab-fields:v1:',
  'jfv-section-fields:v1:',
];

/**
 * One-shot cleanup of pre-v3 storage: discards legacy sync prefs keys and
 * the now-orphaned local field-label/tab/section caches. Never touches
 * v4 shards, the v3 key (migration owns it), SETTINGS_STORAGE_KEY or ACTIVATIONS_STORAGE_KEY.
 */
export async function dropLegacyPrefs(): Promise<void> {
  await chrome.storage.sync.remove(LEGACY_PREFS_KEYS);
  const allLocal = await chrome.storage.local.get(null);
  const staleKeys = Object.keys(allLocal).filter((k) =>
    LEGACY_LOCAL_KEY_PREFIXES.some((prefix) => k.startsWith(prefix))
  );
  if (staleKeys.length > 0) {
    await chrome.storage.local.remove(staleKeys);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One-time v3 → v4 move (HR-3). SW only, on no write chain (HR-4). Fill-missing
 * (v4 wins per type), quota precheck before any write, ONE set, remove(v3) only
 * after that set resolved. Idempotent: the v3 key's existence is the only marker.
 */
export async function migrateV3ToV4(): Promise<{ migrated: number; skipped: number }> {
  const all = await chrome.storage.sync.get(null);
  const v3 = all[PREFS_V3_STORAGE_KEY];
  if (!isPlainObject(v3)) return { migrated: 0, skipped: 0 };

  const changed: Record<string, PrefShard> = {};
  let migrated = 0;
  let skipped = 0;
  for (const [key, raw] of Object.entries(v3)) {
    // Trust the value fields, never the composite key.
    const { host, projectKey, issueTypeId, hiddenFieldIds: ids } = isPlainObject(raw) ? raw : ({} as Record<string, unknown>);
    if (
      typeof host !== 'string' || !host ||
      typeof projectKey !== 'string' || !projectKey ||
      typeof issueTypeId !== 'string' || !issueTypeId || !isKnownIssueType(issueTypeId) ||
      !Array.isArray(ids) || !ids.every((id) => typeof id === 'string')
    ) {
      skipped += 1;
      console.warn(`[jfv] migrateV3ToV4: skipped malformed v3 entry "${key}"`);
      continue;
    }
    const shardKey = makeShardKey(host, projectKey);
    const shard = changed[shardKey] ?? { ...((all[shardKey] as PrefShard | undefined) ?? {}) };
    if (ids.length === 0 || Object.hasOwn(shard, issueTypeId)) continue; // v4 wins
    shard[issueTypeId] = [...new Set(ids as string[])];
    changed[shardKey] = shard;
    migrated += 1;
  }

  for (const [k, shard] of Object.entries(changed)) checkItem(k, shard);
  // ponytail: total is checked for the moment of the set (v3 still present) —
  // that is what the browser enforces. Ceiling: a nearly full sync area keeps
  // retrying every startup until the user frees space.
  const bytes = usageOf({ ...all, ...changed });
  if (bytes > SYNC_QUOTA.total) throw new StorageQuotaError('total', undefined, bytes, SYNC_QUOTA.total);
  if (migrated > 0) await syncSet(changed);
  await syncRemove(PREFS_V3_STORAGE_KEY);
  return { migrated, skipped };
}

/**
 * Drops local label/tab/section caches whose host:project has neither a
 * non-empty v4 shard nor an activation. No-op while v3 still exists
 * (migration pending). Best effort: logs, never throws.
 */
export async function pruneLocalCaches(): Promise<void> {
  try {
    const all = await chrome.storage.sync.get(null);
    if (PREFS_V3_STORAGE_KEY in all) return;
    const keep = new Set(Object.keys((all[ACTIVATIONS_STORAGE_KEY] as ActivationStore | undefined) ?? {}));
    for (const [k, v] of Object.entries(all)) {
      const scope = parseShardKey(k);
      if (scope && Object.keys(v as PrefShard).length > 0) keep.add(makeScopeKey(scope.host, scope.projectKey));
    }
    const local = await chrome.storage.local.get(null);
    const stale = Object.keys(local).filter((k) => {
      const scope = scopeOfLocalCacheKey(k);
      return scope !== null && !keep.has(scope);
    });
    if (stale.length > 0) await chrome.storage.local.remove(stale);
  } catch (e) {
    console.warn('[jfv] pruneLocalCaches failed', e);
  }
}

/**
 * Bulk prefs write for import ('replace': file wins per bucket) and Copy-to
 * ('union': the target keeps its own ids). In-memory merge, per-item + total
 * precheck, then ONE set — all-or-nothing (HR-21). Buckets failing
 * isWritableScope (HR-6) or ending up empty are skipped.
 */
export function writeBuckets(buckets: Pref[], mode: 'replace' | 'union'): Promise<void> {
  return enqueueWrite(async () => {
    const all = await chrome.storage.sync.get(null);
    const changed: Record<string, PrefShard> = {};
    for (const { host, projectKey, issueTypeId, hiddenFieldIds } of buckets) {
      if (!isWritableScope(host, projectKey, issueTypeId)) continue;
      const key = makeShardKey(host, projectKey);
      const shard = changed[key] ?? { ...((all[key] as PrefShard | undefined) ?? {}) };
      const merged = mode === 'union' ? [...idsOf(shard, issueTypeId), ...hiddenFieldIds] : hiddenFieldIds;
      const ids = [...new Set(merged)];
      if (ids.length === 0) continue;
      shard[issueTypeId] = ids;
      changed[key] = shard;
    }
    if (Object.keys(changed).length === 0) return;
    for (const [k, shard] of Object.entries(changed)) checkItem(k, shard);
    const bytes = usageOf({ ...all, ...changed });
    if (bytes > SYNC_QUOTA.total) throw new StorageQuotaError('total', undefined, bytes, SYNC_QUOTA.total);
    await syncSet(changed);
  });
}

/** Unions scopes into the activations item with one set (import). Malformed scopes are skipped. */
export function mergeActivations(scopes: string[]): Promise<void> {
  const result = activationsWriteChain.then(async () => {
    const valid = scopes.filter((s) => parseScopeKey(s) !== null);
    if (valid.length === 0) return;
    const updated: ActivationStore = { ...(await loadActivations()) };
    for (const s of valid) updated[s] = true;
    await syncSet({ [ACTIVATIONS_STORAGE_KEY]: updated });
  });
  activationsWriteChain = result.catch(() => undefined);
  return result;
}

/** Copy-to targets: v4 buckets ∪ label-cache buckets (types the user has opened), known types only, deduped, sorted. */
export async function listKnownBuckets(): Promise<{ host: string; projectKey: string; issueTypeId: string }[]> {
  const found = new Map<string, { host: string; projectKey: string; issueTypeId: string }>();
  const add = (host: string, projectKey: string, issueTypeId: string): void => {
    if (isKnownIssueType(issueTypeId)) found.set(makePrefKey(host, projectKey, issueTypeId), { host, projectKey, issueTypeId });
  };
  for (const p of Object.values(await loadPrefs())) add(p.host, p.projectKey, p.issueTypeId);
  const labelPrefix = LOCAL_CACHE_PREFIXES[0]; // 'jfv-field-labels:v2:'
  for (const k of Object.keys(await chrome.storage.local.get(null))) {
    const scope = k.startsWith(labelPrefix) ? scopeOfLocalCacheKey(k) : null;
    const parts = scope ? parseScopeKey(scope) : null;
    if (scope && parts) add(parts.host, parts.projectKey, k.slice(labelPrefix.length + scope.length + 1));
  }
  return [...found.keys()].sort((a, c) => a.localeCompare(c)).map((k) => found.get(k)!);
}

/** Export snapshot: non-empty v4 shards, activation scopes, exactly the 4 Settings keys (round-trips through validateExport). */
export async function buildExport(): Promise<ExportFileV1> {
  const all = await chrome.storage.sync.get(null);
  const prefs: ExportFileV1['prefs'] = {};
  for (const [k, v] of Object.entries(all)) {
    const scope = parseShardKey(k);
    if (scope && Object.keys(v as PrefShard).length > 0) prefs[makeScopeKey(scope.host, scope.projectKey)] = v as PrefShard;
  }
  const { showFieldButtons, debugOutline, shrinkCover, coverHeightPx } = await loadSettings();
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    prefs,
    activations: Object.keys((all[ACTIVATIONS_STORAGE_KEY] as ActivationStore | undefined) ?? {}),
    settings: {
      showFieldButtons,
      debugOutline,
      shrinkCover,
      coverHeightPx: Math.round(Math.min(600, Math.max(20, Number(coverHeightPx) || DEFAULT_SETTINGS.coverHeightPx))),
    },
  };
}
