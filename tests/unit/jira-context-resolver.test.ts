import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getIssueType, getIssueRoot, watchIssueContext } from '../../src/lib/jira-context-resolver';
import { listFields } from '../../src/lib/field-registry';

function setLocation(pathname: string, search = ''): void {
  window.location.href = `https://example.atlassian.net${pathname}${search}`;
}

function loadFixtureIntoDom(fileName: string): void {
  const html = fs.readFileSync(path.resolve(__dirname, '../fixtures', fileName), 'utf-8');
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : html;
}

afterEach(() => {
  window.location.href = 'https://example.atlassian.net/';
  document.body.innerHTML = '';
});

describe('getIssueType issue-key resolution', () => {
  it('matches the issue key from /browse/ path', () => {
    setLocation('/browse/ABC-123');

    const ctx = getIssueType();

    expect(ctx.issueKey).toBe('ABC-123');
  });

  it('falls back to the selectedIssue query param on board/backlog pages', () => {
    setLocation('/jira/software/c/projects/DEV/boards/2040/backlog', '?selectedIssue=DEV-99144');

    const ctx = getIssueType();

    expect(ctx.issueKey).toBe('DEV-99144');
  });

  it('rejects an invalid selectedIssue query param value', () => {
    setLocation('/jira/software/c/projects/DEV/boards/2040/backlog', '?selectedIssue=not-a-valid-key!!');

    const ctx = getIssueType();

    expect(ctx.issueKey).toBeNull();
  });
});

describe('projectKey derivation (S3)', () => {
  it('extracts projectKey from a /browse/ issue key', () => {
    setLocation('/browse/CSM-12');
    const ctx = getIssueType();
    expect(ctx.projectKey).toBe('CSM');
    expect(ctx.issueKey).toBe('CSM-12');
  });

  it('extracts projectKey from ?selectedIssue= (board panel)', () => {
    setLocation('/jira/software/c/projects/ITSM/boards/1', '?selectedIssue=ITSM-9');
    const ctx = getIssueType();
    expect(ctx.projectKey).toBe('ITSM');
    expect(ctx.issueKey).toBe('ITSM-9');
  });

  it('returns null projectKey when no issue is present', () => {
    setLocation('/jira/software/c/projects/DEV/boards/2040');
    const ctx = getIssueType();
    expect(ctx.projectKey).toBeNull();
    expect(ctx.issueKey).toBeNull();
  });
});

describe('watchIssueContext composite change-detection (S3)', () => {
  it('fires the callback when projectKey changes even if issueTypeId is the same', async () => {
    // Start on CSM project — no issue open yet so first poll sets baseline.
    setLocation('/browse/CSM-1');
    const cb = vi.fn();
    const stop = watchIssueContext(cb);

    // Navigate to a different project (same issueType will resolve to 'unknown' in both cases).
    setLocation('/browse/ITSM-2');

    // Real timers: wait for at least one interval tick (300ms) + debounce (300ms) + margin.
    // Using real timers avoids the fake-timer starvation where the 300ms setInterval
    // always resets the 300ms debounce at the same tick.
    await new Promise<void>(r => setTimeout(r, 800));

    stop();
    expect(cb).toHaveBeenCalled();
    const lastCtx = cb.mock.calls[cb.mock.calls.length - 1][0];
    expect(lastCtx.projectKey).toBe('ITSM');
  }, 5000);
});

describe('board detail-panel scoping', () => {
  it('reads the panel issue type, not a board card behind it', () => {
    loadFixtureIntoDom('jira-board-panel.html');
    setLocation('/jira/software/c/projects/DEV/boards/2040', '?selectedIssue=DEV-119113');

    expect(getIssueType().issueTypeId).toBe('story');
  });

  it('scopes getIssueRoot to the detail panel on a board, and to document on /browse/', () => {
    loadFixtureIntoDom('jira-board-panel.html');

    setLocation('/jira/software/c/projects/DEV/boards/2040', '?selectedIssue=DEV-119113');
    const root = getIssueRoot();
    expect((root as Element).getAttribute?.('data-testid')).toBe(
      'issue.views.issue-details.issue-modal.modal-dialog'
    );
    // Panel fields are in scope; board-card fields (Priority/Assignee) are not.
    const labels = listFields(root).map((f) => f.label);
    expect(labels).toContain('Labels');
    expect(labels).not.toContain('Priority');
    expect(labels).not.toContain('Assignee');

    setLocation('/browse/DEV-119113');
    expect(getIssueRoot()).toBe(document);
  });

  it('returns an empty scope while the panel has not rendered yet', () => {
    document.body.innerHTML = '<div data-testid="platform-board-kit.ui.column"></div>';
    setLocation('/jira/software/c/projects/DEV/boards/2040', '?selectedIssue=DEV-119113');

    expect(listFields(getIssueRoot())).toHaveLength(0);
  });

  it('returns an empty scan root for a bare board URL (no selectedIssue, no /browse/) — regression guard for board-card leak', () => {
    // Board cards render issue-type icons and fields in the DOM, but no issue is
    // open. getIssueRoot() must NOT return document here; it must return an empty
    // fragment so listFields() finds nothing and the eye-icon UI stays off the board.
    document.body.innerHTML = '<div data-testid="platform-board-kit.ui.column"><span class="field">Priority</span></div>';
    setLocation('/jira/software/c/projects/DEV/boards/2040');

    const root = getIssueRoot();

    expect(root.querySelectorAll('*')).toHaveLength(0);
  });
});
