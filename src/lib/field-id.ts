import type { FieldKind } from '../types/field-meta';

/**
 * Trim, collapse internal whitespace to single spaces, lowercase.
 * Pure string function.
 */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Deterministic 32-bit FNV-1a hash, returned as a hex string.
 * No Math.random, no reliance on object key iteration order — operates
 * purely on the input string's characters.
 */
export function hashString(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime (32-bit): 0x01000193, via shift/add per FNV-1a convention
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned 32-bit and render as hex
  return (hash >>> 0).toString(16);
}

/**
 * Slugify an arbitrary string into an id-safe token: lowercase,
 * non-alphanumeric runs collapsed to a single hyphen, trimmed of
 * leading/trailing hyphens.
 */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface DeriveFieldIdOptions {
  kind?: FieldKind;
}

/** Matches a `customfield_<digits>` token anywhere in a string. */
const CUSTOM_FIELD_TOKEN_RE = /customfield_\d+/;

/**
 * Derive a stable field id for a given DOM element + label, using the
 * priority chain: data-testid -> id attribute -> aria-label ->
 * position-independent label-hash fallback.
 *
 * Before falling through that chain, if a `customfield_<digits>` token can
 * be extracted from data-testid (or, failing that, id), it's used as the id
 * directly. Real Jira nests multiple elements (wrapper/inline-edit/read-view)
 * for the same logical field, each with a different data-testid but sharing
 * the same customfield_NNNNN token — collapsing on that token prevents the
 * same field from being registered multiple times.
 *
 * Pure: only reads attributes off the passed-in Element. No DOM
 * mutation, no querying, no global state. The hash fallback intentionally
 * excludes any DOM index/order signal so ids survive field reordering.
 */
export function deriveFieldId(
  el: Element,
  label: string,
  opts?: DeriveFieldIdOptions
): string {
  const testId = el.getAttribute('data-testid');
  if (testId && testId.trim().length > 0) {
    const testIdToken = testId.match(CUSTOM_FIELD_TOKEN_RE)?.[0];
    if (testIdToken) {
      return `id_${testIdToken}`;
    }
  }

  const idAttr = el.getAttribute('id');
  if (idAttr && idAttr.trim().length > 0) {
    const idAttrToken = idAttr.match(CUSTOM_FIELD_TOKEN_RE)?.[0];
    if (idAttrToken) {
      return `id_${idAttrToken}`;
    }
  }

  if (testId && testId.trim().length > 0) {
    return `id_${testId}`;
  }

  if (idAttr && idAttr.trim().length > 0) {
    return `id_${idAttr.trim()}`;
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim().length > 0) {
    return `id_${slugify(ariaLabel)}`;
  }

  const hashInput = `${normalizeLabel(label)}|${opts?.kind ?? 'unknown'}`;
  return `lbl_${hashString(hashInput)}`;
}
