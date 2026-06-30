export interface Pref {
  projectKey: string; // '*' = wildcard / legacy bucket
  issueTypeId: string;
  hiddenFieldIds: string[];
}

/** Composite key format: `${projectKey}:${issueTypeId}` */
export type PrefsStore = Record<string, Pref>;

export const DEFAULT_PROJECT_KEY = '*';

/** Build the composite storage key for a project+issueType combination. */
export function makePrefKey(projectKey: string, issueTypeId: string): string {
  return `${projectKey}:${issueTypeId}`;
}

export const PREFS_STORAGE_KEY_V1 = 'jiraFieldVisibility:v1';
export const PREFS_STORAGE_KEY = 'jiraFieldVisibility:v2';

export interface Settings {
  showFieldButtons: boolean;
}

export const SETTINGS_STORAGE_KEY = 'jiraFieldVisibility:settings:v1';

export const DEFAULT_SETTINGS: Settings = { showFieldButtons: true };
