import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer, { type Browser } from 'puppeteer';
import { startFixtureServer, type FixtureServerHandle } from '../fixtures/fixture-server';

// ponytail: the real manifest only matches atlassian.net, so Chrome won't
// auto-inject content.js on the localhost fixture server. Rather than widen
// the shipped manifest's host_permissions (a real scope regression), copy
// dist/ to a temp dir with a test-only manifest that also matches localhost.
// Icons are stripped too since icons/*.png don't exist yet (Wave 8 manual step)
// and an unpacked load can warn/fail on a missing icon file.
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
  delete manifest.icons;
  fs.writeFileSync(path.join(testDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return testDir;
}

export interface ExtensionTestContext {
  browser: Browser;
  fixtureServer: FixtureServerHandle;
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

  return {
    browser,
    fixtureServer,
    fixtureUrl: (fileName: string) => `${fixtureServer.url}/${fileName}`,
    teardown: async () => {
      await browser.close();
      await fixtureServer.close();
      fs.rmSync(extensionDir, { recursive: true, force: true });
    },
  };
}
