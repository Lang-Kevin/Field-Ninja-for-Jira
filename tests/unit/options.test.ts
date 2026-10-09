import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/storage-service', () => {
  const mk = (host: string, projectKey: string) => ({
    host,
    projectKey,
    issueTypeId: 'bug',
    hiddenFieldIds: ['lbl_priority'],
  });
  return {
    loadPrefs: async () => ({ a: mk('a.atlassian.net', 'AAA'), b: mk('b.atlassian.net', 'BBB') }),
    loadActivations: async () => ({}),
    loadFieldLabels: async () => ({}),
    clearPref: vi.fn(),
    clearPrefs: vi.fn(),
    toggleField: vi.fn(),
    getPref: vi.fn(),
    setActivated: vi.fn(),
  };
});
import { titleize, humanizeFieldId } from '../../src/options/options';

describe('titleize', () => {
  it('converts a hyphenated slug to Title Case', () => {
    expect(titleize('user-story')).toBe('User Story');
  });

  it('capitalizes a single word', () => {
    expect(titleize('bug')).toBe('Bug');
  });

  it('returns empty string for empty input', () => {
    expect(titleize('')).toBe('');
  });

  it('handles an already-mixed slug', () => {
    expect(titleize('sub-task')).toBe('Sub Task');
  });
});

describe('humanizeFieldId', () => {
  it('strips the id_ prefix and humanizes the rest', () => {
    expect(humanizeFieldId('id_customfield_10001')).toBe('Customfield 10001');
  });

  it('strips the lbl_ prefix', () => {
    expect(humanizeFieldId('lbl_priority')).toBe('Priority');
  });

  it('collapses non-alnum runs into single spaces and titlecases each word', () => {
    expect(humanizeFieldId('foo--bar__baz')).toBe('Foo Bar Baz');
  });

  it('returns the original id unchanged when it reduces to zero words', () => {
    expect(humanizeFieldId('')).toBe('');
  });
});

describe('search filter', () => {
  it('hides buckets that do not match the query', async () => {
    document.body.innerHTML =
      '<input id="prefs-search" type="search"><div id="prefs-list"></div><p id="prefs-no-match" hidden></p>';
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(document.querySelectorAll('.jfv-project-group').length).toBe(2));
    const input = document.getElementById('prefs-search') as HTMLInputElement;
    input.value = 'BBB';
    input.dispatchEvent(new Event('input'));
    const groups = Array.from(document.querySelectorAll<HTMLElement>('.jfv-project-group'));
    expect(groups.map((g) => g.hidden)).toEqual([true, false]);
  });
});
