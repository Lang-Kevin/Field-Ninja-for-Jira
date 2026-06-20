import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { listFields, listPanels } from '../../src/lib/field-registry';

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
});
