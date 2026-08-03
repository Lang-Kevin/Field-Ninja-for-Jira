import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer, { type Browser } from 'puppeteer';
import { startFixtureServer, type FixtureServerHandle } from '../fixtures/fixture-server';

// ponytail: the real manifest only matches atlassian.net, so Chrome won't
// auto-inject content.js on the localhost fixture server. Rather than widen
// the shipped manifest's host_permissions (a real scope regression), copy
// dist/ to a temp dir with a test-only manifest that also matches localhost.
function buildTestExtensionDir(fixtureOrigin: string): string {
  const distDir = path.resolve(__dirname, '../../dist');
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfv-ext-'));

  for (const name of fs.readdirSync(distDir)) {
    fs.cpSync(path.join(distDir, name), path.join(testDir, name), { recursive: true });
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(testDir, 'manifest.json'), 'utf-8'));
  manifest.host_permissions = [...manifest.host_permissions, `${fixtureOrigin}/*`];
  manifest.content_scripts[0].matches = [
    ...manifest.content_scripts[0].matches,
    `${fixtureOrigin}/*`,
  ];
  fs.writeFileSync(path.join(testDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return testDir;
}

export interface ExtensionTestContext {
  browser: Browser;
  fixtureServer: FixtureServerHandle;
  extensionId: string;
  fixtureUrl: (fileName: string) => string;
  teardown: () => Promise<void>;
}

export async function launchExtension(): Promise<ExtensionTestContext> {
  const fixtureServer = await startFixtureServer();
  const extensionDir = buildTestExtensionDir(fixtureServer.url);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });

  // ponytail: content-entry.ts's render() gates on site-scoped activation
  // (src/types/prefs.ts's ACTIVATIONS_STORAGE_KEY / makeScopeKey). Seed the
  // scopes the fixtures navigate to so the real gate runs instead of being
  // bypassed. Keys mirror `${host}:${projectKey}` — host is the resolver's
  // location.hostname ('localhost', no port), not a literal string import
  // since this test file doesn't resolve src/ imports.
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const extId = new URL(swTarget.url()).host;
  const seed = await browser.newPage();
  await seed.goto(`chrome-extension://${extId}/popup.html`);
  await seed.evaluate(() =>
    chrome.storage.sync.set({
      'jiraFieldVisibility:activations:v1': {
        // 'localhost:TEST' — /browse/TEST-1 default fixtureUrl() (most tests)
        'localhost:TEST': true,
        // 'localhost:EPIC' — fixtures navigating to /browse/EPIC-*
        'localhost:EPIC': true,
        // 'localhost:DEV' — board-late-testid.test.ts and
        // board-late-panel-icons.test.ts, which cold-load a board URL with
        // ?selectedIssue=DEV-119113 (no /browse/ path)
        'localhost:DEV': true,
      },
    })
  );
  await seed.close();

  return {
    browser,
    fixtureServer,
    extensionId: extId,
    // ponytail: route through /browse/<key> so jira-context-resolver.ts's
    // URL gate (onIssuePage) is satisfied on first paint — see
    // fixture-server.ts's /browse/ handling.
    fixtureUrl: (fileName: string) => `${fixtureServer.url}/browse/TEST-1?fixture=${fileName}`,
    teardown: async () => {
      await browser.close();
      await fixtureServer.close();
      fs.rmSync(extensionDir, { recursive: true, force: true });
    },
  };
}
