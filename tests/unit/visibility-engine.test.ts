import { describe, it, expect, beforeEach, vi } from 'vitest';

function createMockChromeStorage() {
  let store: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => {
      return Promise.resolve(key in store ? { [key]: store[key] } : {});
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      store = { ...store, ...items };
      return Promise.resolve();
    }),
    _reset: () => {
      store = {};
    },
    _raw: () => store,
    _seed: (data: Record<string, unknown>) => {
      store = { ...store, ...data };
    },
  };
}

let mockStorage: ReturnType<typeof createMockChromeStorage>;

beforeEach(() => {
  mockStorage = createMockChromeStorage();
  (globalThis as any).chrome = { storage: { sync: mockStorage } };
});

import { computeVisibilityDiff, applyVisibility, toggleField } from '../../src/lib/visibility-engine';
import { PREFS_STORAGE_KEY } from '../../src/types/prefs';
import type { FieldMeta } from '../../src/types/field-meta';

/** Flush a requestAnimationFrame-scheduled callback (happy-dom backs rAF with a timer). */
function flushRaf(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/** Reads back the data-jfv-hidden attribute state as a boolean. */
function isHidden(el: HTMLElement): boolean {
  return el.getAttribute('data-jfv-hidden') === 'true';
}

function makeField(id: string, initiallyHidden = false, isProtected = false): FieldMeta {
  const node = document.createElement('span'); // inner control — must never be written to
  const containerNode = document.createElement('div'); // row/section — the real target
  if (initiallyHidden) {
    containerNode.setAttribute('data-jfv-hidden', 'true');
  }
  return { id, label: id, node, containerNode, protected: isProtected };
}

describe('computeVisibilityDiff', () => {
  it('excludes fields whose current hidden state already matches the desired value (idempotency)', () => {
    const visibleAlready = makeField('f1', false); // desired: visible — already matches
    const hiddenAlready = makeField('f2', true); // desired: hidden — already matches
    const fields = [visibleAlready, hiddenAlready];

    const diff = computeVisibilityDiff(fields, new Set(['f2']));

    expect(diff).toEqual([]);
  });

  it('includes fields whose desired hidden state differs from current, with correct desiredHidden', () => {
    const toHide = makeField('f1', false); // currently visible, should become hidden
    const toShow = makeField('f2', true); // currently hidden, should become visible
    const fields = [toHide, toShow];

    const diff = computeVisibilityDiff(fields, new Set(['f1']));

    expect(diff.length).toBe(2);

    const entryForF1 = diff.find((e) => e.field.id === 'f1');
    const entryForF2 = diff.find((e) => e.field.id === 'f2');

    expect(entryForF1?.desiredHidden).toBe(true);
    expect(entryForF2?.desiredHidden).toBe(false);
  });

  it('never resolves a protected field to hidden, even if its id is in hiddenFieldIds', () => {
    const protectedField = makeField('summary', false, true);

    const diff = computeVisibilityDiff([protectedField], new Set(['summary']));

    // Already visible and desired stays visible — no diff entry needed.
    expect(diff).toEqual([]);
    expect(isHidden(protectedField.containerNode)).toBe(false);
  });

  it('forces a protected field back to visible if it was somehow already hidden in the DOM', () => {
    const protectedField = makeField('summary', true, true);

    const diff = computeVisibilityDiff([protectedField], new Set(['summary']));

    expect(diff.length).toBe(1);
    expect(diff[0].desiredHidden).toBe(false);
  });

  it('accepts hiddenFieldIds as a plain array as well as a Set', () => {
    const toHide = makeField('f1', false);
    const diff = computeVisibilityDiff([toHide], ['f1']);

    expect(diff.length).toBe(1);
    expect(diff[0].desiredHidden).toBe(true);
  });

  it('targets containerNode, never node (distinct elements per field, proves correct targeting)', () => {
    const field = makeField('f1', false);
    expect(field.node).not.toBe(field.containerNode);

    const diff = computeVisibilityDiff([field], new Set(['f1']));

    expect(diff.length).toBe(1);
    expect(diff[0].field.containerNode).toBe(field.containerNode);
    // The diff entry's field reference must resolve back to containerNode, not node.
    expect(diff[0].field.containerNode).not.toBe(diff[0].field.node);
  });
});

describe('toggleField', () => {
  it('hides the field by setting data-jfv-hidden on containerNode (not node)', () => {
    const field = makeField('f1', false);
    toggleField(field, true);

    expect(isHidden(field.containerNode)).toBe(true);
    expect(field.node.hasAttribute('data-jfv-hidden')).toBe(false); // untouched
  });

  it('is idempotent — calling with the same hidden=true again does not throw', () => {
    const field = makeField('f1', false);
    toggleField(field, true);
    expect(isHidden(field.containerNode)).toBe(true);

    expect(() => toggleField(field, true)).not.toThrow();
    expect(isHidden(field.containerNode)).toBe(true);
  });

  it('shows the field again by removing data-jfv-hidden from containerNode when hidden=false', () => {
    const field = makeField('f1', false);
    toggleField(field, true);
    expect(isHidden(field.containerNode)).toBe(true);

    toggleField(field, false);
    expect(isHidden(field.containerNode)).toBe(false);
  });

  it('refuses to hide a protected field even when called with hidden=true', () => {
    const field = makeField('summary', false, true);
    toggleField(field, true);

    expect(isHidden(field.containerNode)).toBe(false);
  });
});

describe('applyVisibility', () => {
  it('hides only the current issueType\'s hidden fields, leaving others visible (per-issueType isolation)', async () => {
    mockStorage._seed({
      [PREFS_STORAGE_KEY]: {
        TYPE_A: { issueTypeId: 'TYPE_A', hiddenFieldIds: ['f1'] },
        TYPE_B: { issueTypeId: 'TYPE_B', hiddenFieldIds: ['f2'] },
      },
    });

    const f1 = makeField('f1', false); // hidden under TYPE_A
    const f2 = makeField('f2', false); // hidden under TYPE_B, but NOT under TYPE_A — must stay visible

    await applyVisibility('TYPE_A', [f1, f2]);
    await flushRaf();

    expect(isHidden(f1.containerNode)).toBe(true);
    expect(isHidden(f2.containerNode)).toBe(false); // not hidden under TYPE_A's prefs
  });

  it('applies TYPE_B prefs independently when called for TYPE_B', async () => {
    mockStorage._seed({
      [PREFS_STORAGE_KEY]: {
        TYPE_A: { issueTypeId: 'TYPE_A', hiddenFieldIds: ['f1'] },
        TYPE_B: { issueTypeId: 'TYPE_B', hiddenFieldIds: ['f2'] },
      },
    });

    const f1 = makeField('f1', false);
    const f2 = makeField('f2', false);

    await applyVisibility('TYPE_B', [f1, f2]);
    await flushRaf();

    expect(isHidden(f2.containerNode)).toBe(true);
    expect(isHidden(f1.containerNode)).toBe(false); // not hidden under TYPE_B's prefs
  });

  it('treats a rejected storage read as "nothing hidden" rather than throwing', async () => {
    mockStorage.get.mockImplementationOnce(() => Promise.reject(new Error('storage unavailable')));

    const f1 = makeField('f1', false);

    await expect(applyVisibility('TYPE_A', [f1])).resolves.toBeUndefined();
    await flushRaf();

    expect(isHidden(f1.containerNode)).toBe(false); // nothing hidden, no throw
  });

  it('is a no-op (no scheduled write) when no field needs to change', async () => {
    mockStorage._seed({
      [PREFS_STORAGE_KEY]: {
        TYPE_A: { issueTypeId: 'TYPE_A', hiddenFieldIds: [] },
      },
    });

    const f1 = makeField('f1', false); // already visible, desired visible — no diff

    await applyVisibility('TYPE_A', [f1]);
    await flushRaf();

    expect(isHidden(f1.containerNode)).toBe(false);
  });
});
