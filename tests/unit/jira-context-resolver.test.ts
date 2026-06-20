import { describe, it, expect, afterEach } from 'vitest';
import { getIssueType } from '../../src/lib/jira-context-resolver';

function setLocation(pathname: string, search = ''): void {
  window.location.href = `https://example.atlassian.net${pathname}${search}`;
}

afterEach(() => {
  window.location.href = 'https://example.atlassian.net/';
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
