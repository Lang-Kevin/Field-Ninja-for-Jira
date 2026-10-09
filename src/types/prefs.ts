export interface Pref {
  /** location.hostname, lowercased — no port (keeps the colon-delimited key unambiguous). */
  host: string;
  projectKey: string;
  issueTypeId: string;
  hiddenFieldIds: string[];
}

/** Composite key format: `${host}:${projectKey}:${issueTypeId}` */
export type PrefsStore = Record<string, Pref>;

/** Composite key format: `${host}:${projectKey}` */
export type ActivationStore = Record<string, true>;

/** Build the composite scope key for a host+project combination. */
export function makeScopeKey(host: string, projectKey: string): string {
  return `${host}:${projectKey}`;
}

/** Build the composite storage key for a host+project+issueType combination. */
export function makePrefKey(host: string, projectKey: string, issueTypeId: string): string {
  return `${makeScopeKey(host, projectKey)}:${issueTypeId}`;
}

/** Storage-local key holding fieldId→label for a host+project+issueType combo. */
export function fieldLabelKey(host: string, projectKey: string, issueTypeId: string): string {
  return `jfv-field-labels:v2:${host}:${projectKey}:${issueTypeId}`;
}

/** Storage-local key holding the tab-fields cache for a host+project+issueType combo. */
export function tabCacheKey(host: string, projectKey: string, issueTypeId: string): string {
  return `jfv-tab-fields:v2:${host}:${projectKey}:${issueTypeId}`;
}

/** Storage-local key holding the section-fields cache for a host+project+issueType combo. */
export function sectionCacheKey(host: string, projectKey: string, issueTypeId: string): string {
  return `jfv-section-fields:v2:${host}:${projectKey}:${issueTypeId}`;
}

export const PREFS_STORAGE_KEY = 'jiraFieldVisibility:v3';
export const ACTIVATIONS_STORAGE_KEY = 'jiraFieldVisibility:activations:v1';

/** Old prefs keys — discarded on upgrade, no migration. */
export const LEGACY_PREFS_KEYS = ['jiraFieldVisibility:v1', 'jiraFieldVisibility:v2'];

/** v4: one sync item per host+project scope. Value = issueTypeId → hiddenFieldIds (deduped, non-empty). */
export const PREFS_V4_PREFIX = 'jiraFieldVisibility:v4:';
/** v3 single-item store. Read only by migrateV3ToV4 (pruneLocalCaches: existence check). */
export const PREFS_V3_STORAGE_KEY = 'jiraFieldVisibility:v3';

export type PrefShard = Record<string, string[]>;

export function makeShardKey(host: string, projectKey: string): string {
  return `${PREFS_V4_PREFIX}${makeScopeKey(host, projectKey)}`;
}

/** `host:PROJ` → parts. host = hostname (no ':'), project = [A-Z][A-Z0-9_]* — exactly one ':'. */
export function parseScopeKey(scope: string): { host: string; projectKey: string } | null {
  const i = scope.indexOf(':');
  if (i <= 0 || i === scope.length - 1 || scope.indexOf(':', i + 1) !== -1) return null;
  return { host: scope.slice(0, i), projectKey: scope.slice(i + 1) };
}

export function parseShardKey(key: string): { host: string; projectKey: string } | null {
  return key.startsWith(PREFS_V4_PREFIX) ? parseScopeKey(key.slice(PREFS_V4_PREFIX.length)) : null;
}

export const LOCAL_CACHE_PREFIXES = ['jfv-field-labels:v2:', 'jfv-tab-fields:v2:', 'jfv-section-fields:v2:'] as const;

/** `jfv-*:v2:${host}:${project}:${type}` → `${host}:${project}`; anything else → null. */
export function scopeOfLocalCacheKey(key: string): string | null {
  const prefix = LOCAL_CACHE_PREFIXES.find((p) => key.startsWith(p));
  if (!prefix) return null;
  const rest = key.slice(prefix.length);
  const i = rest.indexOf(':');
  const j = rest.indexOf(':', i + 1);
  if (i <= 0 || j <= i + 1 || j === rest.length - 1) return null;
  return rest.slice(0, j);
}

// ponytail: typeof guard — prefs.ts loads in contexts/tests without a `chrome`
// global; Firefox may not expose the constants at all.
export const SYNC_QUOTA = {
  perItem: (typeof chrome !== 'undefined' ? chrome.storage?.sync?.QUOTA_BYTES_PER_ITEM : undefined) ?? 8192,
  total: (typeof chrome !== 'undefined' ? chrome.storage?.sync?.QUOTA_BYTES : undefined) ?? 102400,
};

export interface Settings {
  showFieldButtons: boolean;
  debugOutline: boolean;
  shrinkCover: boolean;
  coverHeightPx: number;
}

export const SETTINGS_STORAGE_KEY = 'jiraFieldVisibility:settings:v1';

export const DEFAULT_SETTINGS: Settings = {
  showFieldButtons: true,
  debugOutline: false,
  shrinkCover: false,
  coverHeightPx: 80,
};
