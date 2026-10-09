import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const activated = { value: false };
vi.mock('../../src/lib/storage-service', () => ({
  clearPrefs: vi.fn(async () => {}),
  isActivated: vi.fn(async () => activated.value),
  loadSettings: vi.fn(async () => ({})),
  saveSettings: vi.fn(),
  setActivated: vi.fn(async (_h: string, _p: string, v: boolean) => {
    activated.value = v;
  }),
  setHiddenFields: vi.fn(),
  toggleField: vi.fn(),
}));

const chromeMock = { tabs: { query: vi.fn(), sendMessage: vi.fn() } };
let warn: { mockRestore(): void } | undefined;
const URL_OK = 'https://a.atlassian.net/browse/ABC-1';

const resp = (over: object = {}) => ({
  host: 'a.atlassian.net',
  projectKey: 'ABC',
  issueTypeId: 'bug',
  onIssuePage: true,
  isActive: true,
  fields: [{ id: 'f1', label: 'Priority', hidden: false }],
  ...over,
});

const html = `<p id="status-message"></p><div id="scope-bar"><span id="scope-label"></span>
<button id="activate-button"></button></div><div id="field-list"></div><div id="field-button-row">
<button id="hide-all-button"></button><button id="show-all-button"></button></div>
<button id="reset-all-button"></button><div id="settings-block"></div>`;

const vis = (id: string) => !document.getElementById(id)!.classList.contains('jfv-hidden');
const status = () => document.getElementById('status-message')!.textContent;

async function load(): Promise<void> {
  document.body.innerHTML = html;
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await vi.advanceTimersByTimeAsync(0);
}

beforeAll(async () => {
  (globalThis as any).chrome = chromeMock;
  await import('../../src/popup/popup');
});

beforeEach(() => {
  vi.useFakeTimers();
  activated.value = false;
  chromeMock.tabs.query.mockReset().mockResolvedValue([{ id: 1, url: URL_OK }]);
  chromeMock.tabs.sendMessage.mockReset().mockResolvedValue(resp());
});
afterEach(() => {
  warn?.mockRestore();
  vi.useRealTimers();
});

describe('popup states', () => {
  it('S0: ineligible url', async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: 'https://example.com/' }]);
    await load();
    expect(status()).toBe('Not available on this page.');
    expect(vis('settings-block')).toBe(false);
  });

  it('S1: no content script', async () => {
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('no receiver'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load();
    expect(status()).toContain('Reload the page');
  });

  it('S2: no project', async () => {
    chromeMock.tabs.sendMessage.mockResolvedValue(resp({ projectKey: null }));
    await load();
    expect(status()).toContain('No project detected');
  });

  it('S3: not activated -> Enable here', async () => {
    await load();
    expect(document.getElementById('activate-button')!.textContent).toBe('Enable here');
    expect(vis('field-list')).toBe(false);
  });

  it('S4: activated, not on issue page', async () => {
    activated.value = true;
    chromeMock.tabs.sendMessage.mockResolvedValue(resp({ onIssuePage: false, fields: [] }));
    await load();
    expect(document.getElementById('scope-label')!.textContent).toBe('Active on ABC');
    expect(document.getElementById('field-list')!.textContent).toContain('Open an issue');
    expect((document.getElementById('hide-all-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('S5: activated on issue page lists fields', async () => {
    activated.value = true;
    await load();
    expect(document.getElementById('activate-button')!.textContent).toBe('Disable here');
    expect(document.querySelectorAll('.jfv-field-row').length).toBe(1);
    expect(vis('field-list')).toBe(true);
  });
});

describe('handleActivate polling', () => {
  const calls = () => chromeMock.tabs.sendMessage.mock.calls.length;

  it('stops polling once GET_FIELDS reports isActive', async () => {
    chromeMock.tabs.sendMessage
      .mockResolvedValueOnce(resp({ isActive: false })) // init refresh
      .mockResolvedValueOnce(resp({ isActive: false })) // poll 1
      .mockResolvedValue(resp({ isActive: true })); // poll 2 + final refresh
    await load();
    (document.getElementById('activate-button') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls()).toBe(4); // init + 2 polls + final refresh
    expect(document.getElementById('activate-button')!.textContent).toBe('Disable here');
  });

  it('gives up after 200ms when never active', async () => {
    chromeMock.tabs.sendMessage.mockResolvedValue(resp({ isActive: false }));
    await load();
    const before = calls();
    (document.getElementById('activate-button') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(1000);
    const polls = calls() - before - 1; // minus final refresh
    expect(polls).toBeGreaterThan(1);
    expect(polls).toBeLessThanOrEqual(9);
    expect(chromeMock.tabs.query).toHaveBeenCalledTimes(3); // init + one hoisted poll query + final refresh, not per poll
  });

  it('breaks on mid-poll sendMessage rejection and still refreshes', async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chromeMock.tabs.sendMessage
      .mockResolvedValueOnce(resp({ isActive: false })) // init refresh
      .mockRejectedValueOnce(new Error('gone')) // poll 1
      .mockResolvedValue(resp({ isActive: true })); // final refresh
    await load();
    (document.getElementById('activate-button') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls()).toBe(3); // init + failed poll + final refresh
    expect(document.getElementById('activate-button')!.textContent).toBe('Disable here');
  });
});
