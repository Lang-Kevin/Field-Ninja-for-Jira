// Firefox counterpart to pw-real.mjs. Same assertions, same tenant, headless.
// Playwright cannot install an unsigned MV3 add-on; Puppeteer's WebDriver-BiDi
// Firefox transport can, via installExtension() + a pinned moz-extension UUID.
//
// Usage: node scripts/e2e-firefox.mjs [--headed]
// Requires: npm run build:firefox
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './e2e-checks.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist-firefox');
const PROFILE = path.join(ROOT, '.firefox-jira-profile');
const EXT_ID = 'field-ninja@fieldninja.app';
// Firefox derives the moz-extension:// origin from a random per-profile UUID.
// Pinning it via the uuids pref is the only way to build extension URLs upfront.
const EXT_UUID = 'f1e1d1a1-1111-4111-8111-111111111111';
const tenant = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/tenant.json'), 'utf8'));
const HEADED = process.argv.includes('--headed');

if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('dist-firefox/ missing — run `npm run build:firefox`');
  process.exit(1);
}
// gecko.id is load-bearing: without it Firefox denies storage.sync and every
// pref write fails. Fail loudly here rather than 20 checks later.
const mf = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
if (mf.browser_specific_settings?.gecko?.id !== EXT_ID) {
  console.error(`dist-firefox manifest gecko.id != ${EXT_ID}`);
  process.exit(1);
}

// ponytail: `npx puppeteer browsers install firefox` writes nothing usable on
// Windows (only .metadata lands in the cache), so point at the installed
// Firefox. Must be >= manifest.firefox.json's strict_min_version.
const FIREFOX = process.env.JFV_FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe';

const ORIGIN = `https://${tenant.host}`;
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: fs.existsSync(FIREFOX) ? FIREFOX : undefined,
  headless: !HEADED,
  userDataDir: PROFILE,
  extraPrefsFirefox: {
    'extensions.webextensions.uuids': JSON.stringify({ [EXT_ID]: EXT_UUID }),
    'xpinstall.signatures.required': false,
  },
});
await browser.installExtension(DIST);

const extUrl = (f) => `moz-extension://${EXT_UUID}/${f}`;

// Same cookie rule as pw-real.mjs: the hostname is not a login signal.
// Puppeteer's Browser.cookies() takes no origin argument (unlike Playwright's
// context.cookies(url)), so filter by domain here.
const hasSession = async () =>
  (await browser.cookies()).some(
    (k) => /session\.token/.test(k.name) && String(k.domain ?? '').endsWith(tenant.host.split('.').slice(-2).join('.'))
  );

const errorLog = new WeakMap();
const openPage = async () => {
  const p = await browser.newPage();
  const errs = [];
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  errorLog.set(p, errs);
  return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const p = await openPage();
  await p.goto(`${ORIGIN}/jira/your-work`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  if (!(await hasSession())) {
    await browser.close();
    console.error(
      HEADED
        ? `\n>>> Kein Login im Profil für ${tenant.host} — bitte im Fenster anmelden und erneut starten.\n`
        : '\n>>> Kein Login im .firefox-jira-profile/. Einmalig `node scripts/e2e-firefox.mjs --headed` laufen lassen und dort anmelden.\n'
    );
    process.exit(1);
  }
  await p.close();
}

/** Popup opened as a tab is itself active, so tabs.query would see it, not Jira. */
async function readPopup(popup, jiraPage) {
  if (popup.url() !== extUrl('popup.html')) await popup.goto(extUrl('popup.html'));
  await jiraPage.bringToFront();
  await popup.reload();
  await sleep(600);
  return popup;
}

const driver = {
  extUrl,
  newPage: openPage,
  goto: (p, url) => p.goto(url, { waitUntil: 'domcontentloaded' }),
  wait: (p, ms) => sleep(ms),
  count: (p, sel) => p.$$eval(sel, (els) => els.length).catch(() => 0),
  click: (p, sel) => p.click(sel),
  text: (p, sel) => p.$eval(sel, (e) => e.innerText.trim()).catch(() => ''),
  visible: (p, sel) => p.$eval(sel, (e) => !!e.offsetParent).catch(() => false),
  evalPage: (p, fn) => p.evaluate(fn),
  consoleErrors: (p) => errorLog.get(p) ?? [],
  close: (p) => p.close().catch(() => {}),
  refreshPopup: readPopup,
  async evalInExt(fn) {
    const x = await browser.newPage();
    await x.goto(extUrl('popup.html'));
    const out = await x.evaluate(fn);
    await x.close();
    return out;
  },
};

try {
  const { passed, results, failed } = await runChecks(driver, tenant);
  console.log(`\nfirefox: ${passed}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
}
