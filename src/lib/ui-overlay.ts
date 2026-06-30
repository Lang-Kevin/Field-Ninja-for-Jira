/**
 * ui-overlay.ts (Wave 4 / Milestone 5)
 *
 * Presentation + wiring only. Renders the per-field toggle button, wiring it
 * to the already-built visibility-engine.toggleField (DOM) and
 * storage-service.toggleField (persistence) functions. Does not derive field
 * ids, does not decide what's hidden on its own, does not touch
 * MutationObserver. The field list/checkbox panel lives in the popup
 * (src/popup/) instead — a popup can't reach into the page's DOM directly,
 * so it talks to content-entry.ts via messaging instead of this module.
 *
 * No innerHTML anywhere — all DOM is built via document.createElement plus
 * textContent/attribute setters, since field labels originate from
 * untrusted Jira page text. Every class name injected into the live Jira
 * page is `jfv-` prefixed to avoid colliding with Jira's own styles.
 */

import type { FieldMeta } from '../types/field-meta';
import { toggleField as applyFieldVisibility } from './visibility-engine';
import { toggleField as persistFieldVisibility } from './storage-service';
import { markOwnMutation } from './dom-observer';

const FIELD_TOGGLE_CLASS = 'jfv-field-toggle';
const FIELD_TOGGLE_HIDDEN_CLASS = 'jfv-field-toggle--hidden';

const EYE_OPEN_GLYPH = '\u{1F441}'; // 👁
const EYE_CLOSED_GLYPH = '\u{1F648}'; // 🙈

/**
 * Performs the shared two-step toggle action: immediate DOM visibility via
 * visibility-engine, then persistence via storage-service. Persistence
 * failures are swallowed (matching this project's defensive-coding
 * pattern elsewhere) — the visual state has already been applied, and a
 * failed write will simply be retried next time prefs are saved.
 *
 * onCommit, if provided, fires synchronously right after the DOM write —
 * before storage-service's async round-trip. content-entry.ts uses this to
 * update its own currentHiddenFieldIds cache immediately, so a DOM-mutation
 * rescan landing before the storage write/onPrefsChanged round-trip
 * completes sees the new state instead of reverting this optimistic write.
 */
function commitFieldVisibility(
  field: FieldMeta,
  projectKey: string | null,
  issueTypeId: string,
  hidden: boolean,
  onCommit?: (fieldId: string, hidden: boolean) => void
): void {
  applyFieldVisibility(field, hidden);
  onCommit?.(field.id, hidden);
  void persistFieldVisibility(projectKey, issueTypeId, field.id, hidden).catch((err) => {
    // Best-effort persistence; visual state already reflects user intent,
    // but log so a real failure (e.g. quota exceeded) isn't fully silent.
    console.error('[jfv] failed to persist field visibility', err);
  });
}

function toggleButtonLabel(fieldLabel: string, hidden: boolean): string {
  return hidden ? `Show ${fieldLabel} field` : `Hide ${fieldLabel} field`;
}

/**
 * Injects a small per-field toggle control next to the given field's
 * containerNode. Clicking it applies the new visibility immediately (via
 * visibility-engine), persists it (via storage-service), and updates its own
 * aria-label/icon to reflect the new state.
 *
 * Returns a cleanup function that removes the injected control.
 */
export function mountFieldToggle(
  field: FieldMeta,
  projectKey: string | null,
  issueTypeId: string,
  initiallyHidden: boolean,
  onCommit?: (fieldId: string, hidden: boolean) => void
): () => void {
  // Protected fields (e.g. Summary, Status) are never user-hideable — no
  // toggle button is mounted for them at all.
  if (field.protected) {
    return () => {};
  }

  let hidden = initiallyHidden;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = FIELD_TOGGLE_CLASS;
  button.setAttribute('aria-label', toggleButtonLabel(field.label, hidden));
  button.textContent = hidden ? EYE_CLOSED_GLYPH : EYE_OPEN_GLYPH;
  button.classList.toggle(FIELD_TOGGLE_HIDDEN_CLASS, hidden);

  button.addEventListener('click', () => {
    hidden = !hidden;
    commitFieldVisibility(field, projectKey, issueTypeId, hidden, onCommit);
    markOwnMutation(() => {
      button.setAttribute('aria-label', toggleButtonLabel(field.label, hidden));
      button.textContent = hidden ? EYE_CLOSED_GLYPH : EYE_OPEN_GLYPH;
      button.classList.toggle(FIELD_TOGGLE_HIDDEN_CLASS, hidden);
    });
  });

  // Appended as a child of the container so it travels with the field's
  // existing layout rather than reflowing/replacing Jira's own children.
  // The button is positioned absolutely (see styles.css) so it never
  // participates in the container's own layout flow (e.g. gets pushed below
  // the field by flex/grid wrapping) — that requires the container itself to
  // be a positioning context, so a static container is promoted to relative.
  markOwnMutation(() => {
    if (getComputedStyle(field.containerNode).position === 'static') {
      field.containerNode.style.position = 'relative';
    }
    field.containerNode.appendChild(button);
  });

  return () => {
    markOwnMutation(() => {
      button.remove();
    });
  };
}

