export type FieldKind =
  | 'text'
  | 'select'
  | 'multiselect'
  | 'user'
  | 'date'
  | 'number'
  | 'richtext'
  | 'unknown';

export interface FieldMeta {
  id: string;
  label: string;
  node: HTMLElement;
  containerNode: HTMLElement;
  kind?: FieldKind;
  /** Protected fields (e.g. Summary, Status) are never user-hideable. */
  protected?: boolean;
}

/**
 * A Jira tab button (e.g. "Key Details") paired with the panel it controls,
 * discovered via the standard ARIA tabs pattern (role="tab" + aria-controls
 * -> role="tabpanel"/id). Used to hide a tab whose every field is hidden.
 */
export interface TabMeta {
  tabNode: HTMLElement;
  panelNode: HTMLElement;
}
