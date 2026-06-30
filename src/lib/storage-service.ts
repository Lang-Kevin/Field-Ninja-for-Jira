import type { Pref, PrefsStore, Settings } from '../types/prefs';
import {
  PREFS_STORAGE_KEY,
  PREFS_STORAGE_KEY_V1,
  SETTINGS_STORAGE_KEY,
  DEFAULT_SETTINGS,
  DEFAULT_PROJECT_KEY,
  makePrefKey,
} from '../types/prefs';
import { isKnownIssueType } from './jira-context-resolver';

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
 * Storage escape-hatch note: savePrefs caps the single v2 item at
 * QUOTA_BYTES_PER_ITEM (8KB). If per-project × per-type entry count ever
 * exceeds that, split into per-project keys `jiraFieldVisibility:v2:${projectKey}`
 * (chrome.storage.sync allows up to 512 items / 100KB total).
 */

export function migrateIfNeeded(raw: unknown): PrefsStore {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  // Detect v1: any key without ':' means this is a legacy (pre-v2) store.
  // v2 keys always contain ':' (composite `projectKey:issueTypeId` format).
  if (keys.length > 0 && keys.some((k) => !k.includes(':'))) {
    const migrated: PrefsStore = {};
    for (const [issueTypeId, pref] of Object.entries(obj)) {
      const compositeKey = makePrefKey(DEFAULT_PROJECT_KEY, issueTypeId);
      migrated[compositeKey] = {
        projectKey: DEFAULT_PROJECT_KEY,
        issueTypeId,
        hiddenFieldIds: (pref as { hiddenFieldIds?: string[] }).hiddenFieldIds ?? [],
      };
    }
    return migrated;
  }
  return obj as PrefsStore;
}

export async function loadPrefs(): Promise<PrefsStore> {
  const result = await chrome.storage.sync.get([PREFS_STORAGE_KEY, PREFS_STORAGE_KEY_V1]);
  const rawV2 = result[PREFS_STORAGE_KEY];
  if (rawV2 !== undefined) {
    return migrateIfNeeded(rawV2);
  }
  // No v2 data — attempt lazy migration from v1
  const rawV1 = result[PREFS_STORAGE_KEY_V1];
  if (rawV1 === undefined) {
    return {};
  }
  const migrated = migrateIfNeeded(rawV1);
  // Merge guard: re-read v2 immediately before writing so a concurrent tab
  // that wrote v2 during our async gap isn't clobbered. Existing v2 entries
  // WIN over migrated ones. Not fully atomic (no storage transactions), but
  // the gap shrinks to negligible — the only remaining window is the single
  // round-trip between this get and the following set.
  const { [PREFS_STORAGE_KEY]: latestV2 = {} } = await chrome.storage.sync.get(PREFS_STORAGE_KEY);
  const merged = { ...migrated, ...(latestV2 as Record<string, unknown>) };
  await savePrefs(merged as PrefsStore);
  await chrome.storage.sync.remove(PREFS_STORAGE_KEY_V1);
  return merged as PrefsStore;
}

export async function savePrefs(store: PrefsStore): Promise<void> {
  const payload = { [PREFS_STORAGE_KEY]: store };
  // chrome.storage.sync caps a single item at QUOTA_BYTES_PER_ITEM (8KB).
  // Checking here surfaces a clear error instead of a silently-dropped write
  // (callers like ui-overlay.ts fire-and-forget toggleField).
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (bytes > chrome.storage.sync.QUOTA_BYTES_PER_ITEM) {
    throw new Error(
      `jiraFieldVisibility prefs (${bytes}B) exceed chrome.storage.sync's per-item quota (${chrome.storage.sync.QUOTA_BYTES_PER_ITEM}B)`
    );
  }
  await chrome.storage.sync.set(payload);
}

/**
 * Returns the pref for a project+issueType combo.
 * Null projectKey is coerced to DEFAULT_PROJECT_KEY ('*') at this boundary.
 * Falls back to wildcard bucket `*:${issueTypeId}` when no exact entry exists.
 */
export async function getPref(projectKey: string | null, issueTypeId: string): Promise<Pref> {
  const resolvedProjectKey = projectKey ?? DEFAULT_PROJECT_KEY;
  const store = await loadPrefs();
  const exactKey = makePrefKey(resolvedProjectKey, issueTypeId);
  const wildcardKey = makePrefKey(DEFAULT_PROJECT_KEY, issueTypeId);
  return (
    store[exactKey] ??
    store[wildcardKey] ??
    { projectKey: resolvedProjectKey, issueTypeId, hiddenFieldIds: [] }
  );
}

/** Clears all per-issue-type hidden-field prefs. Leaves Settings untouched. */
export async function clearPrefs(): Promise<void> {
  await chrome.storage.sync.remove([PREFS_STORAGE_KEY, PREFS_STORAGE_KEY_V1]);
}

/** Deletes the pref for a single project+issueType combo. */
export async function clearPref(projectKey: string | null, issueTypeId: string): Promise<void> {
  const resolvedProjectKey = projectKey ?? DEFAULT_PROJECT_KEY;
  const store = await loadPrefs();
  const key = makePrefKey(resolvedProjectKey, issueTypeId);
  if (!(key in store)) return;
  const updatedStore = { ...store };
  delete updatedStore[key];
  await savePrefs(updatedStore);
}

/**
 * Subscribes to changes of the prefs key in chrome.storage.sync — fires for
 * writes from ANY context, including this one (e.g. content-entry.ts's own
 * toggleField calls), so callers can treat storage as the single source of
 * truth instead of re-reading it speculatively after a local write race.
 * Returns an unsubscribe function.
 */
export function onPrefsChanged(cb: (store: PrefsStore) => void): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ): void => {
    if (areaName !== 'sync' || !(PREFS_STORAGE_KEY in changes)) {
      return;
    }
    cb(migrateIfNeeded(changes[PREFS_STORAGE_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_STORAGE_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_STORAGE_KEY]: settings });
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

async function doToggleField(
  projectKey: string | null,
  issueTypeId: string,
  fieldId: string,
  hidden: boolean
): Promise<PrefsStore> {
  // ponytail: guard at the single storage gateway rather than every caller,
  // so an 'unknown' issueTypeId (resolved-context not yet ready) can never
  // create a bogus PrefsStore bucket, no matter who calls toggleField.
  if (!isKnownIssueType(issueTypeId)) {
    return loadPrefs();
  }

  const resolvedProjectKey = projectKey ?? DEFAULT_PROJECT_KEY;
  const store = await loadPrefs();

  // Seed the new bucket from fallback resolution (exact → wildcard → empty)
  // so the first toggle in a project inherits the wildcard/default set, then diverges.
  const exactKey = makePrefKey(resolvedProjectKey, issueTypeId);
  const wildcardKey = makePrefKey(DEFAULT_PROJECT_KEY, issueTypeId);
  const seed = store[exactKey] ?? store[wildcardKey] ?? { projectKey: resolvedProjectKey, issueTypeId, hiddenFieldIds: [] };

  const hiddenSet = new Set(seed.hiddenFieldIds);
  if (hidden) {
    hiddenSet.add(fieldId);
  } else {
    hiddenSet.delete(fieldId);
  }

  const updatedPref: Pref = {
    projectKey: resolvedProjectKey,
    issueTypeId,
    hiddenFieldIds: [...hiddenSet],
  };

  const updatedStore: PrefsStore = {
    ...store,
    [exactKey]: updatedPref,
  };

  await savePrefs(updatedStore);
  return updatedStore;
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

export function toggleField(
  projectKey: string | null,
  issueTypeId: string,
  fieldId: string,
  hidden: boolean
): Promise<PrefsStore> {
  issuedWriteSeq += 1;
  const result = writeQueue.then(() => doToggleField(projectKey, issueTypeId, fieldId, hidden));
  writeQueue = result.catch(() => undefined);
  // void: result's own rejection is already handled by writeQueue's .catch
  // above; this .finally() only exists to re-converge committedWriteSeq on
  // both success and failure, and `void` suppresses the unhandled-rejection
  // warning on the .finally()-derived promise without an extra no-op .catch.
  void result.finally(() => {
    committedWriteSeq += 1;
  });
  return result;
}
