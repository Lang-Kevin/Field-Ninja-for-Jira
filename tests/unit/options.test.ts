import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

const m = vi.hoisted(() => ({
  writeBuckets: vi.fn(async (_b: unknown[], _mode: string) => {}),
  mergeActivations: vi.fn(async (_s: string[]) => {}),
  saveSettings: vi.fn(async (_s: unknown) => {}),
  buildExport: vi.fn(async () => ({ format: 'field-ninja-for-jira', version: 1, prefs: {}, activations: [] })),
  getSyncUsage: vi.fn(async () => ({ bytes: 3174, quota: 102400 })),
}));
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
    quotaMessage: (e: unknown) => (e instanceof Error && e.message === 'quota' ? 'Sync storage full (100 KB)' : null),
    ...m,
  };
});
import { titleize, humanizeFieldId, handleImportFile } from '../../src/options/options';

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

const PAGE =
  '<p id="storage-usage"></p><p id="storage-error" hidden></p><p id="storage-status" hidden></p><div id="prefs-list"></div>';
const VALID = JSON.stringify({
  format: 'field-ninja-for-jira',
  version: 1,
  prefs: { 'acme.atlassian.net:PROJ': { story: ['f1', 'f2'], bug: ['f3'] } },
  activations: ['acme.atlassian.net:PROJ'],
  settings: { showFieldButtons: true, debugOutline: false, shrinkCover: true, coverHeightPx: 80 },
});

function fakeFile(content: string, size = content.length) {
  const text = vi.fn(async () => content);
  return { file: { size, text } as unknown as File, text };
}

const box = (id: string) => document.getElementById(id)!;

describe('storage usage line', () => {
  it('renders after every render', async () => {
    document.body.innerHTML = PAGE;
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(box('storage-usage').textContent).toBe('Sync storage: 3.1 of 100 KB'));
  });
});

describe('import', () => {
  let ask: Mock<[], boolean>;
  let warn: { mockRestore(): void };

  beforeEach(() => {
    document.body.innerHTML = PAGE;
    for (const f of Object.values(m)) f.mockClear();
    ask = vi.fn(() => true);
    vi.stubGlobal('confirm', ask);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  // RF-3
  it('oversized file rejected before text() is read', async () => {
    const { file, text } = fakeFile(VALID, 262145);
    await handleImportFile(file);
    expect(text).not.toHaveBeenCalled();
    expect(box('storage-error').hidden).toBe(false);
    expect(box('storage-error').textContent).toBe('Import file too large (257 KB > 256 KB).');
    expect(m.writeBuckets).not.toHaveBeenCalled();
  });

  // RF-3
  it('invalid JSON → error, no write', async () => {
    await handleImportFile(fakeFile('{nope').file);
    expect(box('storage-error').textContent).toBe('Import failed: not a valid JSON file.');
    expect(ask).not.toHaveBeenCalled();
    expect(m.writeBuckets).not.toHaveBeenCalled();
  });

  it('schema violation → "<path>: <reason>", no confirm, no write', async () => {
    await handleImportFile(fakeFile(JSON.stringify({ format: 'x', version: 1, prefs: {}, activations: [] })).file);
    expect(box('storage-error').textContent).toBe('Import failed: $.format: expected "field-ninja-for-jira"');
    expect(ask).not.toHaveBeenCalled();
    expect(m.writeBuckets).not.toHaveBeenCalled();
  });

  it('valid file → confirm with summary, replace-write, merge activations, save settings', async () => {
    await handleImportFile(fakeFile(VALID).file);
    expect(ask).toHaveBeenCalledWith(
      'Import 1 projects, 2 issue types, 3 hidden fields, 1 activations, settings? Matching issue types are overwritten, others kept.'
    );
    expect(m.writeBuckets).toHaveBeenCalledWith(
      [
        { host: 'acme.atlassian.net', projectKey: 'PROJ', issueTypeId: 'story', hiddenFieldIds: ['f1', 'f2'] },
        { host: 'acme.atlassian.net', projectKey: 'PROJ', issueTypeId: 'bug', hiddenFieldIds: ['f3'] },
      ],
      'replace'
    );
    expect(m.mergeActivations).toHaveBeenCalledWith(['acme.atlassian.net:PROJ']);
    expect(m.saveSettings).toHaveBeenCalledWith({ showFieldButtons: true, debugOutline: false, shrinkCover: true, coverHeightPx: 80 });
    expect(box('storage-error').hidden).toBe(true);
    expect(box('storage-status').hidden).toBe(false);
  });

  it('cancel at confirm → no write', async () => {
    ask.mockReturnValueOnce(false);
    await handleImportFile(fakeFile(VALID).file);
    expect(m.writeBuckets).not.toHaveBeenCalled();
    expect(m.mergeActivations).not.toHaveBeenCalled();
  });

  it('quota error from writeBuckets → quota text, activations/settings untouched', async () => {
    m.writeBuckets.mockRejectedValueOnce(new Error('quota'));
    await handleImportFile(fakeFile(VALID).file);
    expect(box('storage-error').textContent).toBe('Sync storage full (100 KB)');
    expect(m.mergeActivations).not.toHaveBeenCalled();
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it('activations fail after prefs landed → partial-failure text', async () => {
    m.mergeActivations.mockRejectedValueOnce(new Error('IO'));
    await handleImportFile(fakeFile(VALID).file);
    expect(box('storage-error').textContent).toBe('Prefs imported; activations/settings failed: Error: IO');
  });
});

describe('export', () => {
  it('downloads buildExport() as field-ninja-export-YYYY-MM-DD.json via Blob + <a download>', async () => {
    document.body.innerHTML = `<button id="export-btn"></button>${PAGE}`;
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:jfv');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(document.querySelectorAll('.jfv-project-group').length).toBe(2));

    box('export-btn').click();
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toMatch(/^field-ninja-export-\d{4}-\d{2}-\d{2}\.json$/);
    const blob = create.mock.calls[0][0] as Blob;
    expect(JSON.parse(await blob.text())).toMatchObject({ format: 'field-ninja-for-jira', version: 1 });
    click.mockRestore();
    create.mockRestore();
  });
});
