/**
 * Internal pub/sub event bus contracts for the content script.
 *
 * These events flow over a plain EventTarget within the content script's own
 * runtime context — they are NOT chrome.runtime messages (see
 * src/types/messages.ts for that contract). This file is intentionally
 * self-contained and must not import from src/types/messages.ts.
 */

export const ON_ISSUE_LOADED = 'jfv:issue-loaded' as const;
export const ON_FIELD_LIST_UPDATED = 'jfv:field-list-updated' as const;
export const ON_TOGGLE_FIELD = 'jfv:toggle-field' as const;

export interface IssueLoadedDetail {
  issueTypeId: string;
}

export interface FieldListUpdatedDetail {
  issueTypeId: string;
  fieldIds: string[];
}

export interface ToggleFieldDetail {
  fieldId: string;
  hidden: boolean;
}

/**
 * Dispatch a typed CustomEvent of `type` with `detail` on `target`.
 */
export function emit<T>(target: EventTarget, type: string, detail: T): void {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

/**
 * Subscribe to a typed CustomEvent of `type` on `target`. Returns an
 * unsubscribe function.
 */
export function on<T>(
  target: EventTarget,
  type: string,
  handler: (detail: T) => void
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<T>).detail);
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
}
