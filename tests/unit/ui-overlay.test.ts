import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/visibility-engine', () => ({ toggleField: vi.fn() }));
vi.mock('../../src/lib/storage-service', () => ({ toggleField: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/lib/dom-observer', () => ({ markOwnMutation: (fn: () => void) => fn() }));

import { mountFieldToggle } from '../../src/lib/ui-overlay';

describe('mountFieldToggle a11y', () => {
  it('is a focusable native button whose aria-label flips; click commits', () => {
    const containerNode = document.createElement('div');
    document.body.appendChild(containerNode);
    const field = { id: 'f1', label: 'Labels', containerNode, protected: false } as any;
    const onCommit = vi.fn();
    mountFieldToggle('h', field, 'P', '1', false, onCommit);

    const btn = containerNode.querySelector('.jfv-field-toggle') as HTMLButtonElement;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.type).toBe('button');
    expect(btn.getAttribute('tabindex')).toBeNull(); // native default order, not removed from tab flow
    const before = btn.getAttribute('aria-label');

    btn.focus();
    expect(document.activeElement).toBe(btn);
    btn.click(); // native button: Enter/Space dispatch click
    expect(onCommit).toHaveBeenCalledWith('f1', true);
    expect(btn.getAttribute('aria-label')).not.toBe(before);
  });
});
