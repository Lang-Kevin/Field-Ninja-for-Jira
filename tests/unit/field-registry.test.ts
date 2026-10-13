import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { listFields, listPanels, listSections, listUndetectedCandidates } from '../../src/lib/field-registry';
import { JIRA_SELECTORS } from '../../src/lib/jira-selectors';

function loadFixtureIntoDom(fileName: string): void {
  const html = fs.readFileSync(
    path.resolve(__dirname, '../fixtures', fileName),
    'utf-8'
  );
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : html;
}

describe('listFields nested inline-edit dedup', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('collapses nested wrapper/inline-edit/read-view elements for the same customfield into a single field', () => {
    loadFixtureIntoDom('jira-issue-nested-inline-edit.html');

    const fields = listFields(document.body);
    const accountFields = fields.filter((f) => f.label === 'Account');

    expect(accountFields).toHaveLength(1);
    expect(fields).toHaveLength(1);
  });
});

describe('listFields protected field marking', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('marks Summary and Status as protected, and leaves other fields unprotected', () => {
    document.body.innerHTML = `
      <div data-testid="issue-field-summary" aria-label="Summary">Some title</div>
      <div data-testid="issue-field-status" aria-label="Status">In Progress</div>
      <div data-testid="issue-field-priority" aria-label="Priority">High</div>
    `;

    const fields = listFields(document.body);
    const byLabel = new Map(fields.map((f) => [f.label, f]));

    expect(byLabel.get('Summary')?.protected).toBe(true);
    expect(byLabel.get('Status')?.protected).toBe(true);
    expect(byLabel.get('Priority')?.protected).toBeFalsy();
  });

  it('marks the real Summary read-only-container as protected even with no aria-label/<label> sibling', () => {
    // No aria-label, no nearby <label> — deriveLabel falls back to raw text
    // ("Some title"), which must not dodge protection via the testid check.
    document.body.innerHTML = `
      <div data-testid="issue-field-summary.ui.issue-field-summary-inline-edit--read-only-container">Some title</div>
    `;

    const fields = listFields(document.body);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.protected).toBe(true);
  });

  it('marks a field whose containerNode resolves to the Status onboarding-spotlight wrapper as protected', () => {
    // The spotlight wrapper carries role="group" (Jira's own focus-trap
    // marker), so findContainer's role="group" fallback can resolve a
    // nested field's containerNode up to this shared wrapper instead of its
    // own row — same shared-container hazard as the role="group" note above,
    // just landing on a Jira-protected node instead of an unprotected one.
    document.body.innerHTML = `
      <div data-testid="ref-spotlight-target-status-spotlight" role="group">
        <div data-testid="issue-field-status-thing">In Progress</div>
      </div>
    `;

    const fields = listFields(document.body);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.containerNode.getAttribute('data-testid')).toBe(
      'ref-spotlight-target-status-spotlight'
    );
    expect(fields[0]?.protected).toBe(true);
  });

  it('marks a field protected when its containerNode is merely a descendant of the spotlight wrapper, not the wrapper itself', () => {
    // An inner role="group" wins findContainer's walk before reaching the
    // spotlight div, so containerNode != the spotlight node — but the button
    // still ends up rendered inside the spotlight wrapper's subtree.
    document.body.innerHTML = `
      <div data-testid="ref-spotlight-target-status-spotlight">
        <div role="group">
          <div data-testid="issue-field-status-thing">In Progress</div>
        </div>
      </div>
    `;

    const fields = listFields(document.body);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.containerNode.getAttribute('data-testid')).toBeNull();
    expect(fields[0]?.protected).toBe(true);
  });
});

describe('listFields empty multiline field via heading-only markup', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('registers exactly one FieldMeta for an empty field block with only a field-heading element (no testid/id/customfield)', () => {
    document.body.innerHTML = `
      <div id="field-wrapper">
        <h2 data-component-selector="jira-issue-field-heading-multiline-field-heading-title">Release Notes (deutsch)</h2>
      </div>
    `;

    const fields = listFields(document.body);
    const wrapper = document.getElementById('field-wrapper');

    expect(fields).toHaveLength(1);
    expect(fields[0]?.label).toBe('Release Notes (deutsch)');
    // findContainer's worst-case fallback for a heading with no
    // CONTAINER_MARKER_SELECTOR match anywhere in its ancestor chain is the
    // heading's own immediate parentElement — confirmed scoped to the
    // heading's wrapper, not document.body or some broader ancestor (real
    // Jira always wraps the heading in at least one div per every DOM
    // snippet seen so far; an unwrapped heading would degrade to hiding
    // document.body, an accepted edge case that can't occur in practice).
    expect(fields[0]?.containerNode).toBe(wrapper);
  });

  it('does not double-register a filled field that has both a heading and a sibling value node', () => {
    document.body.innerHTML = `
      <div>
        <h2 data-component-selector="jira-issue-field-heading-multiline-field-heading-title">Release Notes (deutsch)</h2>
        <div data-testid="issue-internal-fields.text-area.text-content-area">Some release notes text.</div>
      </div>
    `;

    const fields = listFields(document.body);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.node.getAttribute('data-testid')).toBe(
      'issue-internal-fields.text-area.text-content-area'
    );
  });

  it('does not double-register when the value node is 3 ancestor levels above the heading (walk-up must iterate past level 0)', () => {
    // heading is nested inside its own wrapper div (level 0 from heading's
    // parent), which is a sibling of ANOTHER wrapper div containing 2 more
    // levels of nesting before reaching the value node. This forces
    // findHeadingOnlyCandidates's walk-up loop to actually iterate past
    // iteration 0 (unlike the flat sibling case above) before
    // `current.querySelector(FIELD_SELECTOR)` finds the value node, while
    // staying within MAX_CONTAINER_WALK=6.
    document.body.innerHTML = `
      <div>
        <div>
          <h2 data-component-selector="jira-issue-field-heading-multiline-field-heading-title">Release Notes (deutsch)</h2>
        </div>
        <div>
          <div>
            <div data-testid="issue-internal-fields.text-area.text-content-area">Some release notes text.</div>
          </div>
        </div>
      </div>
    `;

    const fields = listFields(document.body);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.node.getAttribute('data-testid')).toBe(
      'issue-internal-fields.text-area.text-content-area'
    );
  });
});

describe('listFields labels-row duplicate-button regression', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('collapses sibling field elements inside anonymous wrappers under a shared labeled container into one field', () => {
    // Real Jira labels row: the outer container has no CONTAINER_MARKER
    // attribute (no role="group", no "field" in testid), but contains a
    // <label> and two customfield-matching siblings each inside their own
    // anonymous wrapper. The old fallback only checked the immediate parent
    // (the anonymous wrapper, which has no label) and returned each field
    // element itself as containerNode — two containers, two buttons.
    document.body.innerHTML = `
      <div data-testid="issue.views.issue-base.context.labels">
        <label>Labels</label>
        <div>
          <div class="customfield-labels-view">frontend, urgent</div>
        </div>
        <div>
          <div class="customfield-labels-edit">+</div>
        </div>
      </div>
    `;

    const fields = listFields(document.body);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.containerNode.getAttribute('data-testid')).toBe(
      'issue.views.issue-base.context.labels'
    );
  });
});

describe('listFields ownership: a genuine <label> tag belonging to another field must not be borrowed', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps two sibling fields under an unmarked wrapper as separate fields with distinct containers, even when only one has its own real <label> tag', () => {
    // Field A has no <label> of its own. Field B has a genuine <label> tag.
    // The shared wrapper has no CONTAINER_MARKER attribute of its own. A
    // tagName-only genuine-label check accepts Field B's <label> as
    // "evidence" that the wrapper is Field A's labeled row too, collapsing
    // both fields onto the same containerNode.
    document.body.innerHTML = `
      <div class="wrapper">
        <div data-testid="issue-field-labels">frontend, urgent</div>
        <div data-testid="issue-field-components">
          <label>Components</label>
        </div>
      </div>
    `;

    const fields = listFields(document.body);
    const labelsField = fields.find((f) => f.node.getAttribute('data-testid') === 'issue-field-labels');
    const componentsField = fields.find(
      (f) => f.node.getAttribute('data-testid') === 'issue-field-components'
    );

    expect(labelsField).toBeDefined();
    expect(componentsField).toBeDefined();
    expect(labelsField?.containerNode).not.toBe(componentsField?.containerNode);
  });
});

describe('listFields sibling field-testid substring-matches LABEL_SELECTOR', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps two sibling fields under an unmarked dialog wrapper as separate containers (jira-board-panel.html)', () => {
    loadFixtureIntoDom('jira-board-panel.html');

    const dialog = document.querySelector(
      '[data-testid="issue.views.issue-details.issue-modal.modal-dialog"]'
    ) as HTMLElement;
    const fields = listFields(dialog);

    const labelsField = fields.find((f) => f.node.getAttribute('data-testid') === 'issue-field-labels');
    const componentsField = fields.find(
      (f) => f.node.getAttribute('data-testid') === 'issue-field-components'
    );

    expect(labelsField).toBeDefined();
    expect(componentsField).toBeDefined();
    expect(labelsField?.containerNode).not.toBe(componentsField?.containerNode);
  });
});

describe('listPanels', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('discovers sidebar app panels and uses the panel element as both node and containerNode', () => {
    document.body.innerHTML = `
      <div data-testid="automation-panel" aria-label="Automation">Automation content</div>
      <div data-testid="tempo-panel" aria-label="Tempo">Tempo content</div>
    `;

    const panels = listPanels(document.body);
    const labels = panels.map((p) => p.label).sort();

    expect(labels).toEqual(['Automation', 'Tempo']);
    for (const panel of panels) {
      expect(panel.node).toBe(panel.containerNode);
    }
  });

  const forge = (app: string, mod: string, title: string) => `
    <div>
      <div data-testid="issue-view-layout-templates-views.ui.context.visible-hidden.ui.ecosystem-context-group.container.context-group-ari:cloud:ecosystem::extension/${app}/env-${mod}/static/${mod}">
        <section data-testid="issue-view-layout-group.common.ui.collapsible-group-factory.context-group-ari:cloud:ecosystem::extension/${app}/env-${mod}/static/${mod}">
          <div><div><div><div><h2 data-testid="issue-view-layout-group.common.ui.collapsible-group-factory.title">${title}</h2></div></div></div></div>
          <div>body</div>
        </section>
      </div>
    </div>`;

  it('lists Forge app sections once each with stable app ids and H2 labels', () => {
    document.body.innerHTML =
      forge('94d5de1a-112d-4549-bd03-5f910d5fd27b', 'okr-issue-context', 'OKR') +
      forge('aaaa1111-0000-0000-0000-000000000000', 'backbone-ctx', 'Backbone') +
      '<div data-testid="issue-field-priority"><label>Priority</label></div>' +
      '<div data-testid="issue-view-layout-templates-views.ui.context.visible-hidden.ui.ecosystem-context-group.container.automation-issue-audit-log-panel">Audit</div>';

    const panels = listPanels(document.body);
    const okr = panels.find((p) => p.id === 'app:94d5de1a-112d-4549-bd03-5f910d5fd27b/okr-issue-context');
    const bb = panels.find((p) => p.id === 'app:aaaa1111-0000-0000-0000-000000000000/backbone-ctx');

    expect(panels).toHaveLength(3);
    expect(okr?.label).toBe('OKR');
    expect(bb?.label).toBe('Backbone');
    expect(okr?.containerNode).toBe(okr?.node);
    expect(okr?.node.tagName).toBe('DIV');
    expect(okr?.containerNode).not.toBe(bb?.containerNode);
    expect(panels.some((p) => p.node.tagName === 'SECTION')).toBe(false);
    expect(panels.map((p) => p.id)).toContain(
      'id_issue-view-layout-templates-views.ui.context.visible-hidden.ui.ecosystem-context-group.container.automation-issue-audit-log-panel'
    );
  });

  it('keeps the app id stable across envIds', () => {
    const mk = (env: string) =>
      `<div data-testid="issue-view-layout-templates-views.ui.context.visible-hidden.ui.ecosystem-context-group.container.context-group-ari:cloud:ecosystem::extension/app1/${env}/static/mod"><h2 data-testid="x.title">T</h2></div>`;
    document.body.innerHTML = mk('env-a');
    const a = listPanels(document.body)[0].id;
    document.body.innerHTML = mk('env-b');
    expect(listPanels(document.body)[0].id).toBe(a);
    expect(a).toBe('app:app1/mod');
  });

  it('skips a Forge app container whose title has not rendered', () => {
    document.body.innerHTML =
      '<div data-testid="issue-view-layout-templates-views.ui.context.visible-hidden.ui.ecosystem-context-group.container.context-group-ari:cloud:ecosystem::extension/app1/env-a/static/mod">body</div>';
    expect(listPanels(document.body)).toHaveLength(0);
  });

  it('listSections excludes the ecosystem app container', () => {
    document.body.innerHTML = forge('app1', 'mod', 'OKR');
    expect(listSections(document.body).some((s) => s.matches(JIRA_SELECTORS.ecosystemPanel))).toBe(false);
  });
});

describe('listUndetectedCandidates', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns only labeled blocks outside every detected container, resolving testid from the nearest ancestor', () => {
    document.body.innerHTML = `
      <div id="detected" data-testid="issue-field-priority">
        <label>Priority</label>
        <span>High</span>
      </div>
      <div id="undetected" data-testid="mystery-block">
        <label>Mystery Field</label>
        <span>Some value</span>
      </div>
    `;

    const detectedContainer = document.getElementById('detected')!;
    const candidates = listUndetectedCandidates(document.body, [detectedContainer]);

    const labelTexts = candidates.map((c) => c.labelText);
    expect(labelTexts).not.toContain('Priority');
    expect(labelTexts).toContain('Mystery Field');

    const mystery = candidates.find((c) => c.labelText === 'Mystery Field');
    expect(mystery?.testid).toBe('mystery-block');
  });

  it('skips sortable-chrome candidates (SORTABLE_CHROME_EXCLUDE_SELECTOR)', () => {
    document.body.innerHTML = `
      <div data-testid="sortable-item-list">
        <label>Excluded Chrome Field</label>
      </div>
    `;

    const candidates = listUndetectedCandidates(document.body, []);
    expect(candidates.map((c) => c.labelText)).not.toContain('Excluded Chrome Field');
  });

  it('skips global-nav candidates (GLOBAL_NAV_EXCLUDE_SELECTOR)', () => {
    document.body.innerHTML = `
      <div aria-label="Sidebar">
        <label>Nav Field</label>
      </div>
    `;

    const candidates = listUndetectedCandidates(document.body, []);
    expect(candidates.map((c) => c.labelText)).not.toContain('Nav Field');
  });

  it('skips child-issues panel candidates (CHILD_ISSUES_EXCLUDE_SELECTOR)', () => {
    document.body.innerHTML = `
      <div data-testid="child-issues-panel">
        <label>Child Field</label>
      </div>
    `;

    const candidates = listUndetectedCandidates(document.body, []);
    expect(candidates.map((c) => c.labelText)).not.toContain('Child Field');
  });

  it('detects a heading-only candidate via FIELD_HEADING_SELECTOR', () => {
    document.body.innerHTML = `
      <div data-testid="mystery-block">
        <span data-component-selector="field-heading-x">Empty Field Heading</span>
      </div>
    `;

    const candidates = listUndetectedCandidates(document.body, []);
    const heading = candidates.find((c) => c.labelText === 'Empty Field Heading');
    expect(heading).toBeDefined();
    expect(heading?.testid).toBe('mystery-block');
  });

  it('dedupes candidates that resolve to the same testid + labelText', () => {
    document.body.innerHTML = `
      <div data-testid="dup-block">
        <label>Duplicate Field</label>
      </div>
      <div data-testid="dup-block">
        <label>Duplicate Field</label>
      </div>
    `;

    const candidates = listUndetectedCandidates(document.body, []);
    const dupes = candidates.filter((c) => c.labelText === 'Duplicate Field');
    expect(dupes).toHaveLength(1);
  });
});
