/**
 * Export/import file schema (HR-21: import is a trust boundary). Pure — no
 * chrome.* calls (HR-5). Any violation rejects the WHOLE file with
 * "<path>: <reason>"; output is always rebuilt into fresh objects.
 */
import type { Settings } from '../types/prefs';
import { isKnownIssueType } from './jira-context-resolver';

export const EXPORT_FORMAT = 'field-ninja-for-jira';

export interface ExportFileV1 {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportedAt?: string;
  /** "<host>:<PROJ>" → issueTypeId → hidden field ids */
  prefs: Record<string, Record<string, string[]>>;
  /** "<host>:<PROJ>" scopes */
  activations: string[];
  settings?: Settings;
}

export interface ExportSummary {
  projects: number;
  buckets: number;
  fields: number;
  activations: number;
  hasSettings: boolean;
}

export type ValidateResult =
  | { ok: true; data: ExportFileV1; summary: ExportSummary }
  | { ok: false; error: string };

const SCOPE_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*:[A-Z][A-Z0-9_]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_KEYS = new Set(['format', 'version', 'exportedAt', 'prefs', 'activations', 'settings']);
const SETTINGS_KEYS = ['showFieldButtons', 'debugOutline', 'shrinkCover', 'coverHeightPx'];

class Invalid extends Error {}

function fail(path: string, reason: string): never {
  throw new Invalid(`${path}: ${reason}`);
}

function plainObject(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) {
    fail(path, 'expected an object');
  }
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k)) fail(`${path}.${k}`, 'forbidden key');
  }
  return v as Record<string, unknown>;
}

function scopeKey(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length > 300 || !SCOPE_RE.test(v)) fail(path, 'expected "<host>:<PROJECT>"');
  return v;
}

function fieldIds(v: unknown, path: string): string[] {
  if (!Array.isArray(v)) fail(path, 'expected an array of field ids');
  if (v.length > 500) fail(path, 'more than 500 field ids');
  v.forEach((id, i) => {
    if (typeof id !== 'string' || id.length < 1 || id.length > 200) fail(`${path}[${i}]`, 'expected a 1-200 char string');
  });
  return [...new Set(v as string[])];
}

function settingsOf(v: unknown): Settings {
  const s = plainObject(v, '$.settings');
  const keys = Object.keys(s);
  if (keys.length !== SETTINGS_KEYS.length || !SETTINGS_KEYS.every((k) => Object.hasOwn(s, k))) {
    fail('$.settings', `expected exactly ${SETTINGS_KEYS.join(', ')}`);
  }
  for (const k of ['showFieldButtons', 'debugOutline', 'shrinkCover']) {
    if (typeof s[k] !== 'boolean') fail(`$.settings.${k}`, 'expected a boolean');
  }
  const h = s.coverHeightPx;
  if (typeof h !== 'number' || !Number.isInteger(h) || h < 20 || h > 600) {
    fail('$.settings.coverHeightPx', 'expected an integer 20-600');
  }
  return {
    showFieldButtons: s.showFieldButtons as boolean,
    debugOutline: s.debugOutline as boolean,
    shrinkCover: s.shrinkCover as boolean,
    coverHeightPx: h,
  };
}

export function validateExport(raw: unknown): ValidateResult {
  try {
    const top = plainObject(raw, '$');
    for (const k of Object.keys(top)) {
      if (!TOP_KEYS.has(k)) fail(`$.${k}`, 'unknown key');
    }
    for (const k of ['format', 'version', 'prefs', 'activations']) {
      if (!Object.hasOwn(top, k)) fail(`$.${k}`, 'missing');
    }
    if (top.format !== EXPORT_FORMAT) fail('$.format', `expected "${EXPORT_FORMAT}"`);
    if (top.version !== 1) fail('$.version', 'unsupported version (expected 1)');
    if (top.exportedAt !== undefined && typeof top.exportedAt !== 'string') fail('$.exportedAt', 'expected a string');

    const prefs: ExportFileV1['prefs'] = {};
    let buckets = 0;
    let fields = 0;
    for (const [scope, shardRaw] of Object.entries(plainObject(top.prefs, '$.prefs'))) {
      scopeKey(scope, `$.prefs.${scope}`);
      const shard: Record<string, string[]> = {};
      for (const [type, list] of Object.entries(plainObject(shardRaw, `$.prefs.${scope}`))) {
        const path = `$.prefs.${scope}.${type}`;
        if (type.length < 1 || type.length > 100 || CONTROL_RE.test(type) || !isKnownIssueType(type)) {
          fail(path, 'invalid issue type');
        }
        const ids = fieldIds(list, path);
        if (ids.length === 0) continue; // empty list = skip bucket, not an error
        shard[type] = ids;
        buckets += 1;
        fields += ids.length;
      }
      if (Object.keys(shard).length > 0) prefs[scope] = shard;
    }

    const act = top.activations;
    if (!Array.isArray(act)) fail('$.activations', 'expected an array');
    if (act.length > 512) fail('$.activations', 'more than 512 entries');
    const activations = [...new Set(act.map((s, i) => scopeKey(s, `$.activations[${i}]`)))];

    const settings = top.settings === undefined ? undefined : settingsOf(top.settings);

    const data: ExportFileV1 = { format: EXPORT_FORMAT, version: 1, prefs, activations };
    if (typeof top.exportedAt === 'string') data.exportedAt = top.exportedAt;
    if (settings) data.settings = settings;
    return {
      ok: true,
      data,
      summary: { projects: Object.keys(prefs).length, buckets, fields, activations: activations.length, hasSettings: !!settings },
    };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}
