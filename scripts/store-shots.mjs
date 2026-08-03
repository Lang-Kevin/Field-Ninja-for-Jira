// Chrome Web Store screenshot generator — NOT part of the test suite.
// Drives the built extension against tests/fixtures/store-demo.html (a synthetic
// issue page: fictional tenant, project and people) and writes 1280x800 PNGs to
// build/store/. Never point this at a real Jira tenant — store assets are public.
//
// Usage:  npm run build && node scripts/store-shots.mjs
import { chromium } from 'playwright-core';
import puppeteer from 'puppeteer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = path.join(ROOT, 'build/store');
const PORT = 4175;
const HOST = 'acme.atlassian.net'; // fictional; --host-resolver-rules maps it to the fixture server
const ORIGIN = `http://${HOST}`;
const FIXTURE = `${ORIGIN}/browse/DEMO-42?fixture=store-demo.html`;

// ponytail: same 15-line static server as scripts/pw-verify.mjs
function serveFixtures() {
  const dir = path.join(ROOT, 'tests/fixtures');
  const server = http.createServer((req, res) => {
    const [rawPath, query] = (req.url ?? '/').split('?');
    const pathname = decodeURIComponent(rawPath);
    const isGated = pathname.startsWith('/browse/') || pathname === '/issues';
    const file = isGated
      ? new URLSearchParams(query ?? '').get('fixture') || 'store-demo.html'
      : pathname.slice(1) || 'store-demo.html';
    const resolved = path.resolve(dir, file);
    if (!resolved.startsWith(dir + path.sep)) return res.writeHead(403).end('Forbidden');
    fs.readFile(resolved, (err, data) =>
      err ? res.writeHead(404).end('Not found')
          : res.writeHead(200, { 'Content-Type': 'text/html' }).end(data)
    );
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

function buildTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfv-shot-'));
  fs.cpSync(path.join(ROOT, 'dist'), dir, { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
  mf.host_permissions = [...mf.host_permissions, `${ORIGIN}/*`];
  mf.content_scripts[0].matches = [...mf.content_scripts[0].matches, `${ORIGIN}/*`];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
  return dir;
}

fs.mkdirSync(OUT, { recursive: true });
const server = await serveFixtures();
const extDir = buildTestExtension();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jfv-shot-profile-'));

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: puppeteer.executablePath(), // bundled Chrome for Testing still allows --load-extension
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${PORT}`,
    '--window-size=1320,940',
    '--hide-scrollbars',
  ],
});

const shot = async (page, name) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`wrote build/store/${name}.png`);
};

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  const issue = await ctx.newPage();
  await issue.goto(FIXTURE);
  await issue.waitForTimeout(1000);

  // Activation runs through the popup's own button; a popup page kept in the
  // background reports the Jira tab as active (see scripts/pw-verify.mjs).
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await issue.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(400);
  await popup.locator('button', { hasText: /^Enable here$/ }).first().click();
  await issue.waitForTimeout(1500);

  const toggles = issue.locator('.jfv-field-toggle');
  if ((await toggles.count()) === 0) throw new Error('no toggles rendered — check the fixture');

  // Fill more of the 1280x800 canvas — the store thumbnail is small. Zoom is
  // toggled off around the clicks: with it on, Chromium's hit-testing puts the
  // field container over the toggle button and every click times out.
  const zoom = (on) => issue.evaluate((v) => (document.body.style.zoom = v), on ? '1.25' : '');
  await zoom(true);
  await issue.bringToFront();
  await shot(issue, '1-toggles');
  await zoom(false);

  // Hide the noisy fields: Sprint, Story Points, Due date, Fix versions.
  for (const label of ['Sprint', 'Story Points', 'Due date', 'Fix versions']) {
    const row = issue.locator('.field-row', { hasText: label }).first();
    await row.locator('.jfv-field-toggle').first().click();
    await issue.waitForTimeout(250);
  }
  await issue.waitForTimeout(600);
  await zoom(true);
  await shot(issue, '2-hidden');

  const options = await ctx.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForTimeout(800);
  await shot(options, '3-options');

  // The popup is 360px wide; centre it on the 1280x800 canvas so the store
  // thumbnail isn't 90% empty. Presentation only — the popup itself is untouched.
  const popupShot = await ctx.newPage();
  await popupShot.goto(`chrome-extension://${extId}/popup.html`);
  await popupShot.addStyleTag({
    content: `html{background:#f7f8f9;height:100%}
              body{margin:48px auto 0;zoom:1.15;box-shadow:0 8px 30px rgba(9,30,66,.25);border-radius:8px;overflow:hidden}`,
  });
  // Same trick as above: the popup only renders its real state while another tab
  // is active, so re-render it from the background before capturing.
  await issue.bringToFront();
  await popupShot.reload();
  await popupShot.addStyleTag({
    content: `html{background:#f7f8f9;height:100%}
              body{margin:48px auto 0;zoom:1.15;box-shadow:0 8px 30px rgba(9,30,66,.25);border-radius:8px;overflow:hidden}`,
  });
  await popupShot.waitForTimeout(500);
  await shot(popupShot, '4-popup');
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
}
