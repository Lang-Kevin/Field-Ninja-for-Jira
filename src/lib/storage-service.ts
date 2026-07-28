import type { ActivationStore, Pref, PrefsStore, Settings } from '../types/prefs';
import {
  PREFS_STORAGE_KEY,
  ACTIVATIONS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  DEFAULT_SETTINGS,
  LEGACY_PREFS_KEYS,
  makePrefKey,
  makeScopeKey,
  fieldLabelKey,
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
 * Storage escape-hatch note: savePrefs caps the single v3 item
 * (PREFS_STORAGE_KEY, `jiraFieldVisibility:v3`) at QUOTA_BYTES_PER_ITEM (8KB).
 * If per-host × per-project × per-type entry count ever exceeds that, split
 * into per-project keys (e.g. `jiraFieldVisibility:v3:${projectKey}`)
 * (chrome.storage.sync allows up to 512 items / 100KB total).
 */

export async function loadPrefs(): Promise<PrefsStore> {
  const result = await chrome.storage.sync.get(PREFS_STORAGE_KEY);
  return (result[PREFS_STORAGE_KEY] as PrefsStore | undefined) ?? {};
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
 * Returns the pref for a host+project+issueType combo. Exact-key lookup only
 * — no fallback chain. A null projectKey never matches a stored pref.
 */
export async function getPref(
  host: string,
  projectKey: string | null,
  issueTypeId: string
): Promise<Pref> {
  if (projectKey === null) {
    return { host, projectKey: '', issueTypeId, hiddenFieldIds: [] };
  }
  const store = await loadPrefs();
  const exactKey = makePrefKey(host, projectKey, issueTypeId);
  return store[exactKey] ?? { host, projectKey, issueTypeId, hiddenFieldIds: [] };
}

/** Clears all per-issue-type hidden-field prefs. Leaves Settings untouched. */
export async function clearPrefs(): Promise<void> {
  await chrome.storage.sync.remove(PREFS_STORAGE_KEY);
}

/** Deletes the pref for a single host+project+issueType combo. */
export async function clearPref(
  host: string,
  projectKey: string | null,
  issueTypeId: string
): Promise<void> {
  if (!host || !projectKey) return;
  const store = await loadPrefs();
  const key = makePrefKey(host, projectKey, issueTypeId);
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
    cb((changes[PREFS_STORAGE_KEY].newValue as PrefsStore | undefined) ?? {});
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
    await chrome.storage.sync.set({ [SETTINGS_STORAGE_KEY]: { ...current, ...settings } });
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
  const resolvedProjectKey = projectKey as string;

  const store = await loadPrefs();

  const exactKey = makePrefKey(host, resolvedProjectKey, issueTypeId);
  const seed = store[exactKey] ?? { host, projectKey: resolvedProjectKey, issueTypeId, hiddenFieldIds: [] };

  const hiddenSet = new Set(seed.hiddenFieldIds);
  if (hidden) {
    hiddenSet.add(fieldId);
  } else {
    hiddenSet.delete(fieldId);
  }

  const updatedPref: Pref = {
    host,
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

async function doSetHiddenFields(
  host: string,
  projectKey: string | null,
  issueTypeId: string,
  deduped: string[]
): Promise<PrefsStore> {
  // Same gateway guard as doToggleField: never seed a bucket for an
  // 'unknown'/not-ready issueTypeId.
  if (!isWritableScope(host, projectKey, issueTypeId)) {
    return loadPrefs();
  }
  const resolvedProjectKey = projectKey as string;

  const store = await loadPrefs();
  const key = makePrefKey(host, resolvedProjectKey, issueTypeId);

  const updatedPref: Pref = {
    host,
    projectKey: resolvedProjectKey,
    issueTypeId,
    hiddenFieldIds: deduped,
  };

  const updatedStore: PrefsStore = {
    ...store,
    [key]: updatedPref,
  };

  await savePrefs(updatedStore);
  return updatedStore;
}

// Runs `fn` serialized after every prior queued write, converging
// issuedWriteSeq/committedWriteSeq exactly like toggleField did inline —
// shared by toggleField and setHiddenFields so both write paths are
// serialized against each other in the same execution context.
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  issuedWriteSeq += 1;
  const result = writeQueue.then(fn);
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

/**
 * Sets the whole hidden-field list for one project+issueType combo in a
 * single write (vs. N sequential toggleField calls). Empty list clears the
 * pref entirely via clearPref. Non-empty writes are routed through the same
 * writeQueue as toggleField so overlapping read-modify-write calls can't
 * clobber each other.
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

  await enqueueWrite(() => doSetHiddenFields(host, projectKey, issueTypeId, deduped));
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
    await chrome.storage.sync.set({ [ACTIVATIONS_STORAGE_KEY]: updated });
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
 * PREFS_STORAGE_KEY, SETTINGS_STORAGE_KEY or ACTIVATIONS_STORAGE_KEY.
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
