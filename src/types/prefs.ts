export interface Pref {
  issueTypeId: string;
  hiddenFieldIds: string[];
}

export type PrefsStore = Record<string, Pref>; // keyed by issueTypeId

export const PREFS_STORAGE_KEY = 'jiraFieldVisibility:v1';

export interface Settings {
  showFieldButtons: boolean;
}

export const SETTINGS_STORAGE_KEY = 'jiraFieldVisibility:settings:v1';

export const DEFAULT_SETTINGS: Settings = { showFieldButtons: true };
