import { describe, it, expect } from 'vitest';
import { deriveFieldId, normalizeLabel } from '../../src/lib/field-id';

describe('deriveFieldId priority chain', () => {
  it('prefers data-testid over aria-label and hash fallback', () => {
    const el = document.createElement('div');
    el.setAttribute('data-testid', 'foo-field');
    el.setAttribute('aria-label', 'Foo Field');

    const id = deriveFieldId(el, 'Foo Field');

    expect(id).toBe('id_foo-field');
    expect(id.startsWith('id_')).toBe(true);
    expect(id).not.toContain('foo field');
  });

  it('falls back to aria-label when data-testid is absent', () => {
    const el = document.createElement('div');
    el.setAttribute('aria-label', 'Story Points');

    const id = deriveFieldId(el, 'Story Points');

    expect(id.startsWith('id_')).toBe(true);
    expect(id).toBe('id_story-points');
  });

  it('falls back to the label-hash when neither attribute is present', () => {
    const el = document.createElement('div');

    const id = deriveFieldId(el, 'Custom Field');

    expect(id.startsWith('lbl_')).toBe(true);
  });
});

describe('deriveFieldId determinism', () => {
  it('returns the identical id across repeated calls with the same inputs', () => {
    const el = document.createElement('div');

    const id1 = deriveFieldId(el, 'Custom Field', { kind: 'text' });
    const id2 = deriveFieldId(el, 'Custom Field', { kind: 'text' });

    expect(id1).toBe(id2);
  });
});

describe('deriveFieldId position-independence', () => {
  it('produces the same id for two elements with identical label/kind regardless of DOM position', () => {
    const parentA = document.createElement('div');
    const elA = document.createElement('div');
    parentA.appendChild(elA);

    const parentB = document.createElement('div');
    const sibling1 = document.createElement('div');
    const sibling2 = document.createElement('div');
    const elB = document.createElement('div');
    parentB.appendChild(sibling1);
    parentB.appendChild(sibling2);
    parentB.appendChild(elB);

    const idA = deriveFieldId(elA, 'Story Points', { kind: 'number' });
    const idB = deriveFieldId(elB, 'Story Points', { kind: 'number' });

    expect(idA).toBe(idB);
    expect(idA.startsWith('lbl_')).toBe(true);
  });
});

describe('deriveFieldId hash input sensitivity', () => {
  it('produces different ids for different label text (same kind)', () => {
    const el1 = document.createElement('div');
    const el2 = document.createElement('div');

    const id1 = deriveFieldId(el1, 'Story Points', { kind: 'text' });
    const id2 = deriveFieldId(el2, 'Sprint', { kind: 'text' });

    expect(id1).not.toBe(id2);
  });

  it('produces different ids for the same label but different kind', () => {
    const el1 = document.createElement('div');
    const el2 = document.createElement('div');

    const id1 = deriveFieldId(el1, 'Story Points', { kind: 'text' });
    const id2 = deriveFieldId(el2, 'Story Points', { kind: 'select' });

    expect(id1).not.toBe(id2);
  });
});

describe('normalizeLabel', () => {
  it('trims, collapses internal whitespace, and lowercases', () => {
    expect(normalizeLabel('  Story   Points  ')).toBe('story points');
  });
});
