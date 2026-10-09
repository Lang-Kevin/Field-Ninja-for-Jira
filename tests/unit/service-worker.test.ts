import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const sw = vi.hoisted(() => {
  const order: string[] = [];
  const step = (name: string) =>
    vi.fn(async () => {
      order.push(name);
    });
  return {
    order,
    storage: { migrateV3ToV4: step('migrate'), pruneLocalCaches: step('prune'), dropLegacyPrefs: step('dropLegacy') },
  };
});
vi.mock('../../src/lib/storage-service', () => sw.storage);

const listeners: Record<string, (...a: any[]) => Promise<void>> = {};
const chromeMock = {
  runtime: {
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
  },
  tabs: {
    get: vi.fn(),
    query: vi.fn(),
    onActivated: { addListener: (fn: any) => (listeners.activated = fn) },
    onUpdated: { addListener: (fn: any) => (listeners.updated = fn) },
  },
  action: { setIcon: vi.fn(async (_i: any) => {}) },
  scripting: { executeScript: vi.fn(), insertCSS: vi.fn(async () => {}) },
};

beforeAll(async () => {
  (globalThis as any).chrome = chromeMock;
  await import('../../src/background/service-worker');
});

beforeEach(() => {
  chromeMock.action.setIcon.mockClear();
  chromeMock.scripting.executeScript.mockReset();
  chromeMock.scripting.insertCSS.mockClear();
});

const cases: [string, string, boolean][] = [
  ['browse', 'https://a.atlassian.net/browse/ABC-1', true],
  ['jira board', 'https://a.atlassian.net/jira/software/projects/ABC/boards/1', true],
  ['issues selectedIssue', 'https://a.atlassian.net/issues?selectedIssue=ABC-1', true],
  ['non-atlassian host', 'https://example.com/browse/ABC-1', false],
  ['atlassian non-eligible path', 'https://a.atlassian.net/wiki/spaces/X', false],
];

describe('service worker icon + injection', () => {
  it.each(cases)('onActivated %s -> colour=%s', async (_n, url, eligible) => {
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: false }]);
    await listeners.activated({ tabId: 7 });
    const icon = chromeMock.action.setIcon.mock.calls[0][0] as any;
    expect(icon.path[16]).toBe(eligible ? 'icons/icon16.png' : 'icons/icon16-grey.png');
    // injection (CSS + script) only for eligible URLs
    expect(chromeMock.scripting.insertCSS).toHaveBeenCalledTimes(eligible ? 1 : 0);
  });

  it('skips injection when content script already loaded', async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: 'https://a.atlassian.net/browse/A-1' });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: true }]);
    await listeners.activated({ tabId: 7 });
    expect(chromeMock.scripting.insertCSS).not.toHaveBeenCalled();
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('onUpdated: injects on complete only; url change only updates icon', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: false }]);
    const tab = { url: 'https://a.atlassian.net/browse/A-1' };
    await listeners.updated(1, { url: tab.url }, tab);
    expect(chromeMock.action.setIcon).toHaveBeenCalledTimes(1);
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();

    await listeners.updated(1, { status: 'complete' }, tab);
    await vi.waitFor(() => expect(chromeMock.scripting.insertCSS).toHaveBeenCalledTimes(1));
  });

  it('onUpdated: ineligible complete -> grey, no injection', async () => {
    await listeners.updated(1, { status: 'complete' }, { url: 'https://example.com/' });
    expect((chromeMock.action.setIcon.mock.calls[0][0] as any).path[16]).toBe('icons/icon16-grey.png');
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe('storage maintenance runs before reinjection (HR-3)', () => {
  const installed = () => chromeMock.runtime.onInstalled.addListener.mock.calls[0][0] as () => Promise<void>;
  const startup = () => chromeMock.runtime.onStartup.addListener.mock.calls[0][0] as () => Promise<void>;

  beforeEach(() => {
    sw.order.length = 0;
    for (const f of Object.values(sw.storage)) f.mockClear();
    chromeMock.tabs.query.mockReset().mockImplementation(async () => {
      sw.order.push('reinject');
      return [];
    });
  });

  it('onInstalled: migrate → prune → dropLegacyPrefs → reinject', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await installed()();
    expect(sw.order).toEqual(['migrate', 'prune', 'dropLegacy', 'reinject']);
    log.mockRestore();
  });

  it('onStartup: migrate → prune → reinject', async () => {
    await startup()();
    expect(sw.order).toEqual(['migrate', 'prune', 'reinject']);
  });

  it('a failed migration is logged and never blocks prune or reinjection', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    sw.storage.migrateV3ToV4.mockRejectedValueOnce(new Error('quota'));
    await startup()();
    expect(sw.order).toEqual(['prune', 'reinject']);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[jfv]'), expect.any(Error));
    err.mockRestore();
  });

  it('a failed dropLegacyPrefs is logged and never blocks reinjection', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    sw.storage.dropLegacyPrefs.mockRejectedValueOnce(new Error('IO'));
    await installed()();
    expect(sw.order).toEqual(['migrate', 'prune', 'reinject']);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[jfv]'), expect.any(Error));
    log.mockRestore();
    err.mockRestore();
  });
});
