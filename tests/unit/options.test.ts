import { describe, it, expect } from 'vitest';
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
