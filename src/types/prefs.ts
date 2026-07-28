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

export interface Settings {
  showFieldButtons: boolean;
  debugOutline: boolean;
}

export const SETTINGS_STORAGE_KEY = 'jiraFieldVisibility:settings:v1';

export const DEFAULT_SETTINGS: Settings = { showFieldButtons: true, debugOutline: false };
