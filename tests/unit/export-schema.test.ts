import { describe, it, expect } from 'vitest';
import { validateExport, EXPORT_FORMAT } from '../../src/lib/export-schema';

const SCOPE = 'acme.atlassian.net:PROJ';

const valid = (): any => ({
  format: 'field-ninja-for-jira',
  version: 1,
  exportedAt: '2026-10-09T10:00:00.000Z',
  prefs: {
    [SCOPE]: { story: ['f1', 'f2', 'f2'], bug: ['f3'], task: [] },
    'other.atlassian.net:DEV_2': { epic: ['f4'] },
    'empty.atlassian.net:EMPTY': { story: [] },
  },
  activations: [SCOPE, SCOPE, 'localhost:TEST'],
  settings: { showFieldButtons: true, debugOutline: false, shrinkCover: true, coverHeightPx: 80 },
});

const mut = (fn: (f: any) => void): unknown => {
  const f = valid();
  fn(f);
  return f;
};

/** Returns the "<path>" part of a rejection's "<path>: <reason>". */
function rejectedPath(raw: unknown): string {
  const r = validateExport(raw);
  if (r.ok) throw new Error('expected a rejection');
  expect(Object.keys(r)).toEqual(['ok', 'error']); // all-or-nothing: no partial data
  return r.error.split(': ')[0];
}

describe('validateExport — accepts', () => {
  it('a full file: dedupes ids, skips empty buckets/scopes, dedupes activations, counts summary', () => {
    const input = valid();
    const r = validateExport(input);
    expect(r).toEqual({
      ok: true,
      data: {
        format: EXPORT_FORMAT,
        version: 1,
        exportedAt: '2026-10-09T10:00:00.000Z',
        prefs: {
          [SCOPE]: { story: ['f1', 'f2'], bug: ['f3'] },
          'other.atlassian.net:DEV_2': { epic: ['f4'] },
        },
        activations: [SCOPE, 'localhost:TEST'],
        settings: { showFieldButtons: true, debugOutline: false, shrinkCover: true, coverHeightPx: 80 },
      },
      summary: { projects: 2, buckets: 3, fields: 4, activations: 2, hasSettings: true },
    });
    if (r.ok) {
      expect(r.data.prefs).not.toBe(input.prefs); // fresh objects, never the file's
      expect(r.data.prefs[SCOPE]).not.toBe(input.prefs[SCOPE]);
    }
  });

  it('a minimal file without exportedAt and settings', () => {
    const r = validateExport({ format: 'field-ninja-for-jira', version: 1, prefs: {}, activations: [] });
    expect(r).toEqual({
      ok: true,
      data: { format: EXPORT_FORMAT, version: 1, prefs: {}, activations: [] },
      summary: { projects: 0, buckets: 0, fields: 0, activations: 0, hasSettings: false },
    });
  });
});

// RF-3
describe('validateExport — rejects the whole file', () => {
  const p = (scope: string, type?: string) => `$.prefs.${scope}${type === undefined ? '' : `.${type}`}`;

  it.each<[string, unknown, string]>([
    ['a non-object root', [], '$'],
    ['a null root', null, '$'],
    ['a string root', '{"format":"field-ninja-for-jira"}', '$'],
    ['an unknown top-level key', mut((f) => (f.extra = 1)), '$.extra'],
    ['missing prefs', mut((f) => delete f.prefs), '$.prefs'],
    ['missing activations', mut((f) => delete f.activations), '$.activations'],
    ['a wrong format', mut((f) => (f.format = 'other')), '$.format'],
    ['version 2', mut((f) => (f.version = 2)), '$.version'],
    ['a non-string exportedAt', mut((f) => (f.exportedAt = 1)), '$.exportedAt'],
    [
      'a top-level __proto__ key',
      JSON.parse('{"__proto__":{},"format":"field-ninja-for-jira","version":1,"prefs":{},"activations":[]}'),
      '$.__proto__',
    ],
    [
      'a __proto__ scope key',
      JSON.parse('{"format":"field-ninja-for-jira","version":1,"prefs":{"__proto__":{"story":["f1"]}},"activations":[]}'),
      '$.prefs.__proto__',
    ],
    ['a constructor type key', mut((f) => (f.prefs[SCOPE] = JSON.parse('{"constructor":["f1"]}'))), p(SCOPE, 'constructor')],
    ['a prototype key in settings', mut((f) => (f.settings = JSON.parse('{"prototype":1}'))), '$.settings.prototype'],
    ['prefs as an array', mut((f) => (f.prefs = [])), '$.prefs'],
    ['an uppercase host', mut((f) => (f.prefs = { 'Acme.atlassian.net:PROJ': { story: ['f1'] } })), p('Acme.atlassian.net:PROJ')],
    ['a lowercase project', mut((f) => (f.prefs = { 'acme.atlassian.net:proj': { story: ['f1'] } })), p('acme.atlassian.net:proj')],
    ['a host with port', mut((f) => (f.prefs = { 'localhost:4173:PROJ': { story: ['f1'] } })), p('localhost:4173:PROJ')],
    ['a scope over 300 chars', mut((f) => (f.prefs = { [`${'a'.repeat(300)}:P`]: { story: ['f1'] } })), p(`${'a'.repeat(300)}:P`)],
    ['the unknown issue type', mut((f) => (f.prefs[SCOPE] = { unknown: ['f1'] })), p(SCOPE, 'unknown')],
    ['a control char in a type', mut((f) => (f.prefs[SCOPE] = { 'st\u0001ory': ['f1'] })), p(SCOPE, 'st\u0001ory')],
    ['a type over 100 chars', mut((f) => (f.prefs[SCOPE] = { ['t'.repeat(101)]: ['f1'] })), p(SCOPE, 't'.repeat(101))],
    ['a non-string field id', mut((f) => (f.prefs[SCOPE] = { story: [1] })), `${p(SCOPE, 'story')}[0]`],
    ['an empty field id', mut((f) => (f.prefs[SCOPE] = { story: [''] })), `${p(SCOPE, 'story')}[0]`],
    ['a field id over 200 chars', mut((f) => (f.prefs[SCOPE] = { story: ['x'.repeat(201)] })), `${p(SCOPE, 'story')}[0]`],
    ['501 field ids', mut((f) => (f.prefs[SCOPE] = { story: Array.from({ length: 501 }, (_, i) => `f${i}`) })), p(SCOPE, 'story')],
    ['a field list that is not an array', mut((f) => (f.prefs[SCOPE] = { story: 'f1' })), p(SCOPE, 'story')],
    ['activations not an array', mut((f) => (f.activations = SCOPE)), '$.activations'],
    ['513 activations', mut((f) => (f.activations = Array(513).fill(SCOPE))), '$.activations'],
    ['a malformed activation', mut((f) => (f.activations = [SCOPE, 'nope'])), '$.activations[1]'],
    ['settings missing a key', mut((f) => delete f.settings.coverHeightPx), '$.settings'],
    ['settings with an extra key', mut((f) => (f.settings.extra = true)), '$.settings'],
    ['a string boolean in settings', mut((f) => (f.settings.showFieldButtons = 'true')), '$.settings.showFieldButtons'],
    ['coverHeightPx 19', mut((f) => (f.settings.coverHeightPx = 19)), '$.settings.coverHeightPx'],
    ['coverHeightPx 601', mut((f) => (f.settings.coverHeightPx = 601)), '$.settings.coverHeightPx'],
    ['a fractional coverHeightPx', mut((f) => (f.settings.coverHeightPx = 20.5)), '$.settings.coverHeightPx'],
  ])('%s', (_name, raw, path) => {
    expect(rejectedPath(raw)).toBe(path);
  });

  it('never pollutes Object.prototype', () => {
    validateExport(JSON.parse('{"format":"field-ninja-for-jira","version":1,"prefs":{"__proto__":{"story":["f1"]}},"activations":[]}'));
    expect(({} as Record<string, unknown>).story).toBeUndefined();
  });
});
