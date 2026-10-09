import { describe, it, expect } from 'vitest';
import {
  PREFS_V4_PREFIX,
  PREFS_V3_STORAGE_KEY,
  ACTIVATIONS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  LOCAL_CACHE_PREFIXES,
  SYNC_QUOTA,
  makeShardKey,
  parseShardKey,
  parseScopeKey,
  scopeOfLocalCacheKey,
  fieldLabelKey,
  tabCacheKey,
  sectionCacheKey,
} from '../../src/types/prefs';

describe('shard keys', () => {
  it('makeShardKey / parseShardKey round-trip', () => {
    const key = makeShardKey('acme.atlassian.net', 'PROJ_2');
    expect(key).toBe('jiraFieldVisibility:v4:acme.atlassian.net:PROJ_2');
    expect(key.startsWith(PREFS_V4_PREFIX)).toBe(true);
    expect(parseShardKey(key)).toEqual({ host: 'acme.atlassian.net', projectKey: 'PROJ_2' });
  });

  it.each([
    PREFS_V3_STORAGE_KEY,
    ACTIVATIONS_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    'jiraFieldVisibility:v4:',
    'jiraFieldVisibility:v4:nohost',
    'jiraFieldVisibility:v4::PROJ',
    'jiraFieldVisibility:v4:a.atlassian.net:',
    'jiraFieldVisibility:v4:a.atlassian.net:P:extra',
    'unrelated',
  ])('parseShardKey rejects %s', (key) => {
    expect(parseShardKey(key)).toBeNull();
  });

  it('parseScopeKey splits on the single colon', () => {
    expect(parseScopeKey('localhost:TEST')).toEqual({ host: 'localhost', projectKey: 'TEST' });
    expect(parseScopeKey('nocolon')).toBeNull();
    expect(parseScopeKey(':P')).toBeNull();
  });
});

describe('scopeOfLocalCacheKey', () => {
  it('maps all three v2 cache keys to host:project', () => {
    for (const make of [fieldLabelKey, tabCacheKey, sectionCacheKey]) {
      expect(scopeOfLocalCacheKey(make('a.atlassian.net', 'ABC', 'bug'))).toBe('a.atlassian.net:ABC');
    }
  });

  it.each([
    'jfv-field-labels:v1:a.atlassian.net:ABC:bug',
    'jfv-field-labels:v2:a.atlassian.net:ABC',
    'jfv-field-labels:v2::ABC:bug',
    'jfv-tab-fields:v2:a.atlassian.net::bug',
    'jfv-section-fields:v2:a.atlassian.net:ABC:',
    'unrelated-key',
    '',
  ])('returns null for %s', (key) => {
    expect(scopeOfLocalCacheKey(key)).toBeNull();
  });

  it('lists exactly the three v2 prefixes', () => {
    expect([...LOCAL_CACHE_PREFIXES]).toEqual([
      'jfv-field-labels:v2:',
      'jfv-tab-fields:v2:',
      'jfv-section-fields:v2:',
    ]);
  });
});

describe('SYNC_QUOTA', () => {
  it('falls back to 8 KB / 100 KB when the browser exposes no constants', () => {
    // No global `chrome` exists in this file, i.e. the Firefox-without-constants path.
    expect(SYNC_QUOTA).toEqual({ perItem: 8192, total: 102400 });
  });
});
