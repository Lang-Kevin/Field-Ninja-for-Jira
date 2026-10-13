import { describe, it, expect, beforeEach } from 'vitest';
import { listControls, listFields, listPanels } from '../../src/lib/field-registry';

const ROW = 'issue.views.issue-base.context.status-and-approvals-wrapper.status-and-approval';
const PATH = 'M8 4l-4 4 4 4';

function html(d = PATH) {
  return `
<div data-testid="${ROW}"><div id="row">
  <div data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"><button>To Do</button></div>
  <div><button data-testid="ai-agents-button.button">Agents</button></div>
  <div></div>
  <div><div><button aria-haspopup="true"><span><span aria-hidden="true"><svg role="presentation"><path d="${d}"/></svg></span></span></button></div></div>
  <div></div>
  <div data-testid="issue.views.issue-base.foundation.status.actions-wrapper"><button><svg><path d="M1 1"/></svg></button></div>
  <div data-testid="issue.views.issue-base.foundation.status.improve-issue"><button>Improve Story</button></div>
</div></div>
<div><div><div style="position:fixed"><button data-testid="platform-ai-button">R</button></div></div></div>`;
}

describe('listControls row structure', () => {
  beforeEach(() => {
    document.body.innerHTML = html();
  });

  it('agents container is the agents child, not the row', () => {
    const a = listControls().find((x) => x.id === 'ctl:ai-agents')!;
    expect(a.containerNode.id).not.toBe('row');
    expect(a.containerNode.parentElement?.id).toBe('row');
    expect(a.containerNode.querySelector('[data-testid="ai-agents-button.button"]')).toBeTruthy();
    expect(a.containerNode.querySelector('[data-testid$="status-field-wrapper"]')).toBeNull();
  });

  it('coding tool found as the single-button child', () => {
    const c = listControls().find((x) => x.label === 'Open in coding tool')!;
    expect(c.containerNode.parentElement?.id).toBe('row');
  });

  it('row child with 2 buttons and no testid is not matched', () => {
    document.getElementById('row')!.insertAdjacentHTML('beforeend', '<div><button><svg><path d="M5 5"/></svg></button><button>x</button></div>');
    expect(listControls().filter((x) => x.label === 'Open in coding tool')).toHaveLength(1);
  });

  it('injected jfv badge with svg path is not matched', () => {
    document.getElementById('row')!.insertAdjacentHTML('beforeend', '<button class="jfv-field-toggle"><svg><path d="M7 7"/></svg></button>');
    expect(listControls().filter((x) => x.label === 'Open in coding tool')).toHaveLength(1);
  });

  it('coding tool still matched after its own badge is mounted inside it', () => {
    const before = listControls().find((x) => x.label === 'Open in coding tool')!;
    before.containerNode.insertAdjacentHTML('beforeend', '<button class="jfv-field-toggle"><svg><path d="M7 7"/></svg></button>');
    const after = listControls().find((x) => x.label === 'Open in coding tool');
    expect(after?.id).toBe(before.id);
    expect(after?.containerNode).toBe(before.containerNode);
  });
});

describe('listControls', () => {
  beforeEach(() => {
    document.body.innerHTML = html();
  });

  it('finds the 4 controls with fixed ids/labels, all compact', () => {
    const c = listControls();
    expect(c.map((x) => x.label)).toEqual(['Agents', 'Improve Story', 'Open in coding tool', 'Rovo']);
    expect(c.map((x) => x.id).slice(0, 2)).toEqual(['ctl:ai-agents', 'ctl:improve-issue']);
    expect(c[2].id).toMatch(/^ctl:icon:[0-9a-f]+$/);
    expect(c[3].id).toBe('ctl:rovo');
    expect(c.every((x) => x.compact)).toBe(true);
  });

  it('coding tool id is stable, path-derived, and never the actions-wrapper', () => {
    const id = listControls()[2].id;
    expect(listControls()[2].id).toBe(id);
    expect(listControls()[2].containerNode.querySelector('path')?.getAttribute('d')).toBe(PATH);
    document.body.innerHTML = html('M9 9h2');
    expect(listControls()[2].id).not.toBe(id);
  });

  it('rovo container is the fixed wrapper', () => {
    expect((listControls()[3].containerNode as HTMLElement).style.position).toBe('fixed');
  });

  it('status field is compact; no id overlaps across lists', () => {
    const fields = listFields();
    const status = fields.find((f) => f.containerNode.matches('[data-testid$="status-field-wrapper"]'));
    expect(status?.compact).toBe(true);
    const ids = [...fields, ...listPanels(), ...listControls()].map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
