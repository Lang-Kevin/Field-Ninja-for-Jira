// Interactive verification harness — NOT part of the test suite.
// Launches the real installed Chrome with dist/ loaded as an unpacked extension,
// so the extension's own runtime (content script, popup, storage) is observable.
// The Vitest/Puppeteer suite stays the durable coverage; this is for one-off checks.
//
// Usage:  node scripts/pw-verify.mjs          (run checks, close browser)
//         node scripts/pw-verify.mjs --keep   (leave browser open for poking)
//
// Requires a fresh build:  npm run build
import { chromium } from 'playwright-core';
import puppeteer from 'puppeteer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 4174; // not 4173 — must not collide with a running test suite
// isEligibleUrl() requires a *.atlassian.net hostname, so a localhost origin can
// never reach the popup/icon code paths (it reports S0 "not available here").
// --host-resolver-rules below points this hostname at the local fixture server,
// making the fixtures indistinguishable from real Jira as far as the gate cares.
const HOST = 'jfv.atlassian.net';
const ORIGIN = `http://${HOST}`;
const KEEP = process.argv.includes('--keep');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ponytail: 15 lines of static server instead of a TS loader for
// tests/fixtures/fixture-server.ts. Same two routes the extension's URL gate cares about.
function serveFixtures() {
  const dir = path.join(ROOT, 'tests/fixtures');
  const server = http.createServer((req, res) => {
    const [rawPath, query] = (req.url ?? '/').split('?');
    const pathname = decodeURIComponent(rawPath);
    const isGated = pathname.startsWith('/browse/') || pathname === '/issues';
    const file = isGated
      ? new URLSearchParams(query ?? '').get('fixture') || 'jira-issue-old-view.html'
      : pathname.slice(1) || 'jira-issue-old-view.html';
    const resolved = path.resolve(dir, file);
    if (!resolved.startsWith(dir + path.sep)) return res.writeHead(403).end('Forbidden');
    fs.readFile(resolved, (err, data) =>
      err
        ? res.writeHead(404).end('Not found')
        : res.writeHead(200, { 'Content-Type': 'text/html' }).end(data)
    );
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

// ponytail: mirrors tests/integration/setup.ts — the shipped manifest only matches
// atlassian.net, so Chrome won't inject into the localhost fixtures. Copy dist/ and
// widen the copy rather than the real manifest.
function buildTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfv-pw-'));
  fs.cpSync(path.join(ROOT, 'dist'), dir, { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
  mf.host_permissions = [...mf.host_permissions, `${ORIGIN}/*`];
  mf.content_scripts[0].matches = [...mf.content_scripts[0].matches, `${ORIGIN}/*`];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
  return dir;
}

const server = await serveFixtures();
const extDir = buildTestExtension();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jfv-profile-'));

const ctx = await chromium.launchPersistentContext(profile, {
  // NOT the system Chrome: from 137 on it silently ignores --load-extension, and
  // by 151 the DisableLoadExtensionCommandLineSwitch escape hatch is gone too
  // (verified: chrome://extensions lists 0 items, no service worker registers).
  // Puppeteer's bundled Chrome for Testing predates that and still allows it.
  executablePath: puppeteer.executablePath(),
  headless: false,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${PORT}`,
  ],
});

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  console.log(`extension id: ${extId}\n`);

  const popupUrl = `chrome-extension://${extId}/popup.html`;
  const toggles = (p) => p.locator('.jfv-field-toggle').count();

  // --- state before any activation -------------------------------------------
  const issue = await ctx.newPage();
  const errors = [];
  issue.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  issue.on('pageerror', (e) => errors.push(String(e)));
  await issue.goto(`${ORIGIN}/browse/TEST-1`);
  await issue.waitForTimeout(1500);
  check('not activated -> no toggles', (await toggles(issue)) === 0);

  // --- the popup trick --------------------------------------------------------
  // popup.ts calls chrome.tabs.query({active:true,currentWindow:true}). A popup
  // opened as a tab is itself the active tab, so it reports S0. Keeping it in the
  // background and reloading it (reload does not focus a tab) makes the query
  // return the Jira tab instead.
  const popup = await ctx.newPage();
  await popup.goto(popupUrl);
  await issue.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(500);
  const popupText = (await popup.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  // Asserts the absence of the S0 copy specifically. An earlier version tested a
  // guessed English phrase and reported PASS on the German S0 text — false green.
  check('popup is not stuck in S0', !/nicht verfügbar/i.test(popupText), popupText.slice(0, 90));

  // --- activate via the popup's own button ------------------------------------
  const activate = popup.locator('button', { hasText: /aktivieren/i }).first();
  const hasButton = (await activate.count()) > 0;
  check('popup offers an activation button', hasButton);
  if (hasButton) {
    await activate.click();
    await issue.waitForTimeout(1500);
    check('activation applies without reload', (await toggles(issue)) > 0, `${await toggles(issue)} toggles`);
  }

  // --- issue navigator (the uncommitted /issues work) --------------------------
  const nav = await ctx.newPage();
  const navErrors = [];
  nav.on('console', (m) => m.type() === 'error' && navErrors.push(m.text()));
  nav.on('pageerror', (e) => navErrors.push(String(e)));
  // getIssueRoot() scopes ?selectedIssue= URLs to the issue-modal panel and returns
  // an empty fragment when it's absent — so this needs a panel fixture, not the
  // standalone-issue one. Serving the wrong fixture reads as "0 toggles", not as a bug.
  await nav.goto(`${ORIGIN}/issues?selectedIssue=TEST-1&fixture=jira-board-panel.html`);
  await nav.waitForTimeout(1500);
  check('/issues?selectedIssue= -> toggles', (await toggles(nav)) > 0, `${await toggles(nav)} toggles`);

  await nav.goto(`${ORIGIN}/issues`);
  await nav.waitForTimeout(1500);
  const jfvErrors = navErrors.filter((e) => e.includes('[jfv]'));
  check('bare /issues -> no toggles', (await toggles(nav)) === 0);
  check('bare /issues -> no [jfv] error', jfvErrors.length === 0, jfvErrors.join(' | '));

  // --- cross-project isolation -------------------------------------------------
  const other = await ctx.newPage();
  await other.goto(`${ORIGIN}/browse/OTHER-1`);
  await other.waitForTimeout(1500);
  check('second project is NOT auto-activated', (await toggles(other)) === 0);

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  if (KEEP) {
    console.log('--keep: browser stays open, Ctrl+C to exit');
    await new Promise(() => {});
  }
} finally {
  if (!KEEP) {
    await ctx.close();
    server.close();
    fs.rmSync(extDir, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
