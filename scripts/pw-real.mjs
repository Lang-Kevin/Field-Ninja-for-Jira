// Real-tenant verification — the counterpart to pw-verify.mjs (which runs on
// static fixtures). This one drives a REAL, logged-in Jira Cloud site, so it is
// the only thing that can check what fixtures cannot: that the PROVISIONAL DOM
// selectors in jira-context-resolver.ts resolve a real issue type, and that
// project keys are detected on Next-Gen / JSM projects.
//
// Usage:
//   node scripts/pw-real.mjs [host] [--headed] [--keep]
//
// The projects, issue keys and custom fields come from tests/tenant.json
// (written by scripts/jira-seed.mjs); the assertions live in e2e-checks.mjs and
// are shared verbatim with the Firefox runner.
//
// Runs headless by default, so it never opens a window on your desktop. Only if
// the profile holds no Jira session does it open one for a one-time login; the
// session is then kept in .playwright-jira-profile/ (gitignored — real cookies)
// and every later run is windowless again.
//
// Requires a fresh build:  npm run build
import { chromium } from 'playwright-core';
import { runChecks } from './e2e-checks.mjs';
import { loginIfNeeded } from './e2e-login.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.playwright-jira-profile');
// Chrome for Testing, not the installed Chrome: 137+ ignores --load-extension and
// by 151 the escape hatch is gone (see pw-verify.mjs). 150 rather than Puppeteer's
// default 127 because real Atlassian dislikes ancient browsers.
// ponytail: env override, homedir default. Pin the version elsewhere if a second one lands.
const CHROME =
  process.env.JFV_CHROME ||
  path.join(os.homedir(), '.cache/puppeteer/chrome/win64-150.0.7871.24/chrome-win64/chrome.exe');

const tenant = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/tenant.json'), 'utf8'));

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const host = argv.filter((a) => !a.startsWith('--'))[0] ?? tenant.host;
const ORIGIN = `https://${host}`;

// Real Jira is served over https://*.atlassian.net, which the shipped manifest
// already matches — no widened copy of dist/ needed here, unlike pw-verify.mjs.
if (!fs.existsSync(path.join(ROOT, 'dist/manifest.json'))) {
  console.error('dist/ missing — run `npm run build` first');
  process.exit(1);
}

// A Chrome window always opens on the ACTIVE Windows virtual desktop, and
// bringToFront() raises it — there is no flag or Playwright API to pin it to
// another desktop. So run headless (Chrome 150's new headless does load
// extensions) and only open a real window when a login is actually needed.
const launch = (headless) =>
  chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless,
    viewport: headless ? { width: 1600, height: 1000 } : null,
    args: [
      `--disable-extensions-except=${path.join(ROOT, 'dist')}`,
      `--load-extension=${path.join(ROOT, 'dist')}`,
    ],
  });

// The hostname is NOT a login signal: an anonymous request to a Jira Cloud site
// stays on <host> and only redirects client-side. Go by the session cookie.
const hasSession = async (c) =>
  (await c.cookies(ORIGIN)).some((k) => /session\.token/.test(k.name));

let ctx = await launch(!argv.includes('--headed'));
{
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  await p.goto(`${ORIGIN}/jira/your-work`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  if (!(await hasSession(ctx))) {
    console.log(`\n>>> Kein Login im Profil. Öffne ein Fenster für ${host} und versuche Auto-Login via auth.json.\n>>> Falls das scheitert (MFA/Captcha): bitte im Fenster manuell anmelden (max 10 min).\n`);
    await ctx.close();
    ctx = await launch(false);
    const lp = ctx.pages()[0] ?? (await ctx.newPage());
    await lp.goto(`${ORIGIN}/jira/your-work`, { waitUntil: 'domcontentloaded' });

    const autoLoggedIn = await loginIfNeeded({
      page: lp,
      hasSession: () => hasSession(ctx),
      sleep: (ms) => lp.waitForTimeout(ms),
      type: (sel, text) => lp.fill(sel, text),
      click: (sel) => lp.click(sel),
      waitFor: (sel, timeoutMs) =>
        lp
          .waitForSelector(sel, { timeout: timeoutMs })
          .then(() => true)
          .catch(() => false),
    });

    if (!autoLoggedIn) {
      // ponytail: Beleg, woran der Auto-Login hing (Account-Chooser? MFA? Captcha?).
      await lp.screenshot({ path: path.join(ROOT, 'login-debug.png') }).catch(() => {});
      console.log('>>> Auto-Login griff nicht — Screenshot: login-debug.png\n');
      const deadline = Date.now() + 600000;
      while (!(await hasSession(ctx))) {
        if (Date.now() > deadline) {
          await ctx.close();
          throw new Error(
            'login timeout — auto-login fehlgeschlagen (fehlende/falsche auth.json, MFA oder Captcha?). Mit --headed laufen lassen und manuell anmelden.'
          );
        }
        await lp.waitForTimeout(3000);
      }
    }
    console.log('>>> Angemeldet. Nächster Lauf startet headless.\n');
  }
}

/** Reload the popup while it sits in the background so tabs.query sees the Jira tab. */
async function readPopup(popup, popupUrl, jiraPage) {
  if (popup.url() !== popupUrl) await popup.goto(popupUrl);
  await jiraPage.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(600);
  return popup;
}


try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
  const extId = new URL(sw.url()).host;
  const popupUrl = `chrome-extension://${extId}/popup.html`;
  console.log(`extension id: ${extId}`);
  console.log(`tenant: ${ORIGIN}\n`);

  const errorLog = new WeakMap();
  const driver = {
    extUrl: (f) => `chrome-extension://${extId}/${f}`,
    async newPage() {
      const p = await ctx.newPage();
      const errs = [];
      p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
      errorLog.set(p, errs);
      return p;
    },
    goto: (p, url) => p.goto(url, { waitUntil: 'domcontentloaded' }),
    wait: (p, ms) => p.waitForTimeout(ms),
    count: (p, sel) => p.locator(sel).count(),
    // ponytail: Toggle-Buttons überlappen sich im echten Jira-Layout, ein
    // Koordinaten-Klick trifft dann den Nachbarn. Direkt aufs Element klicken.
    click: (p, sel) => p.locator(sel).first().dispatchEvent('click'),
    text: (p, sel) => p.locator(sel).first().innerText().catch(() => '').then((t) => t.trim()),
    visible: (p, sel) => p.locator(sel).first().isVisible().catch(() => false),
    evalPage: (p, fn) => p.evaluate(fn),
    consoleErrors: (p) => errorLog.get(p) ?? [],
    close: (p) => p.close().catch(() => {}),
    refreshPopup: (popup, jiraPage) => readPopup(popup, popupUrl, jiraPage),
    async evalInExt(fn) {
      const x = await ctx.newPage();
      await x.goto(popupUrl);
      const out = await x.evaluate(fn);
      await x.close();
      return out;
    },
  };

  const { passed, results, failed } = await runChecks(driver, tenant);
  console.log(`\nchrome: ${passed}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;

  if (KEEP) {
    console.log('--keep: Browser bleibt offen, Ctrl+C zum Beenden');
    await new Promise(() => {});
  }
} finally {
  if (!KEEP) await ctx.close();
}
