// Real-tenant verification — the counterpart to pw-verify.mjs (which runs on
// static fixtures). This one drives a REAL, logged-in Jira Cloud site, so it is
// the only thing that can check what fixtures cannot: that the PROVISIONAL DOM
// selectors in jira-context-resolver.ts resolve a real issue type, and that
// project keys are detected on Next-Gen / JSM projects.
//
// Usage:
//   node scripts/pw-real.mjs <host> [PROJ_A] [PROJ_B]
//   node scripts/pw-real.mjs your-tenant.atlassian.net
//   node scripts/pw-real.mjs your-tenant.atlassian.net --headed
//   node scripts/pw-real.mjs your-tenant.atlassian.net --keep
//
// Runs headless by default, so it never opens a window on your desktop. Only if
// the profile holds no Jira session does it open one for a one-time login; the
// session is then kept in .playwright-jira-profile/ (gitignored — real cookies)
// and every later run is windowless again.
//
// Requires a fresh build:  npm run build
import { chromium } from 'playwright-core';
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

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const [host, ...projectArgs] = argv.filter((a) => !a.startsWith('--'));
if (!host) {
  console.error('usage: node scripts/pw-real.mjs <host.atlassian.net> [PROJ_A] [PROJ_B] [--keep]');
  process.exit(1);
}
const ORIGIN = `https://${host}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

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
    console.log(`\n>>> Kein Login im Profil. Öffne ein Fenster für ${host} — bitte dort anmelden (max 10 min).\n`);
    await ctx.close();
    ctx = await launch(false);
    const lp = ctx.pages()[0] ?? (await ctx.newPage());
    await lp.goto(`${ORIGIN}/jira/your-work`, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + 600000;
    while (!(await hasSession(ctx))) {
      if (Date.now() > deadline) {
        await ctx.close();
        throw new Error('login timeout');
      }
      await lp.waitForTimeout(3000);
    }
    console.log('>>> Angemeldet. Nächster Lauf startet headless.\n');
  }
}

const toggles = (p) => p.locator('.jfv-field-toggle').count();

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

  // The profile is persistent, so chrome.storage.sync survives between runs — a
  // project activated by an EARLIER run would fail the "second project NOT
  // auto-activated" check for the wrong reason. Start every run from scratch.
  const reset = await ctx.newPage();
  await reset.goto(popupUrl);
  await reset.evaluate(() => chrome.storage.sync.clear());
  await reset.close();

  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // --- project discovery -------------------------------------------------------
  let projects = projectArgs;
  if (projects.length === 0) {
    await page.goto(`${ORIGIN}/jira/projects`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    // ponytail: scrape keys out of the raw markup instead of guessing at Jira's
    // ever-changing project-list testids.
    const html = await page.content();
    projects = [...new Set([...html.matchAll(/\/projects\/([A-Z][A-Z0-9]{1,9})\b/g)].map((m) => m[1]))].slice(0, 2);
  }
  console.log(`projects: ${projects.join(', ') || '(none found)'}\n`);
  if (projects.length === 0) {
    console.error('Keine Projekte gefunden — Projektschlüssel als Argument übergeben.');
    throw new Error('no projects');
  }

  /** First real issue key of a project, via the issue navigator. */
  async function firstIssueKey(proj) {
    await page.goto(`${ORIGIN}/issues?jql=${encodeURIComponent(`project=${proj} ORDER BY created ASC`)}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(5000);
    const m = (await page.content()).match(new RegExp(`\\b${proj}-\\d+\\b`));
    return m ? m[0] : null;
  }

  const [projA, projB] = projects;
  const keyA = await firstIssueKey(projA);
  if (!keyA) throw new Error(`no issue found in ${projA}`);
  console.log(`sample issue: ${keyA}\n`);

  const popup = await ctx.newPage();

  // --- before activation --------------------------------------------------------
  const issue = await ctx.newPage();
  const errors = [];
  issue.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await issue.goto(`${ORIGIN}/browse/${keyA}`, { waitUntil: 'domcontentloaded' });
  await issue.waitForTimeout(6000);
  check('real issue, not activated -> no toggles', (await toggles(issue)) === 0);

  await readPopup(popup, popupUrl, issue);
  const scope = (await popup.locator('#scope-label').innerText().catch(() => '')).trim();
  const status = (await popup.locator('#status-message').innerText().catch(() => '')).trim();
  // The core real-tenant question: does the resolver name the project on a live
  // page? Fixtures can't answer this for Next-Gen/JSM layouts.
  check(`project key detected (${projA})`, scope.includes(projA), scope || status);

  const activate = popup.locator('#activate-button');
  const canActivate = (await activate.isVisible().catch(() => false));
  check('popup offers activation on real Jira', canActivate, status);

  if (canActivate) {
    await activate.click();
    await issue.bringToFront();
    await issue.waitForTimeout(6000);
    const n = await toggles(issue);
    check('activation applies without reload', n > 0, `${n} toggles`);

    // Writing a pref is the only externally visible proof that the DOM issue-type
    // read succeeded: isKnownIssueType() blocks the write when it returns 'unknown'.
    if (n > 0) {
      await issue.locator('.jfv-field-toggle').first().click();
      await issue.waitForTimeout(2000);
      const store = await popup.evaluate(async () => {
        const r = await chrome.storage.sync.get('jiraFieldVisibility:v3');
        return Object.keys(r['jiraFieldVisibility:v3'] ?? {});
      });
      check(
        'real issue type resolved (not "unknown")',
        store.length > 0 && !store.some((k) => k.includes('unknown')),
        store.join(', ') || 'nothing written'
      );
    }
  }

  // --- issue navigator ----------------------------------------------------------
  const nav = await ctx.newPage();
  const navErrors = [];
  nav.on('console', (m) => m.type() === 'error' && navErrors.push(m.text()));
  await nav.goto(`${ORIGIN}/issues?selectedIssue=${keyA}`, { waitUntil: 'domcontentloaded' });
  await nav.waitForTimeout(8000);
  const navN = await toggles(nav);
  check('/issues?selectedIssue= -> toggles', navN > 0, `${navN} toggles`);

  await nav.goto(`${ORIGIN}/issues`, { waitUntil: 'domcontentloaded' });
  await nav.waitForTimeout(6000);
  const jfvErrors = navErrors.filter((e) => e.includes('[jfv]'));
  check('bare /issues -> no [jfv] error', jfvErrors.length === 0, jfvErrors.join(' | '));

  // --- second project is a separate scope ----------------------------------------
  if (projB) {
    const keyB = await firstIssueKey(projB);
    if (keyB) {
      const other = await ctx.newPage();
      await other.goto(`${ORIGIN}/browse/${keyB}`, { waitUntil: 'domcontentloaded' });
      await other.waitForTimeout(6000);
      check(`second project (${projB}) NOT auto-activated`, (await toggles(other)) === 0);

      await readPopup(popup, popupUrl, other);
      const scopeB = (await popup.locator('#scope-label').innerText().catch(() => '')).trim();
      check(`project key detected (${projB})`, scopeB.includes(projB), scopeB);
    } else {
      console.log(`SKIP  second project — no issue found in ${projB}`);
    }
  }

  // --- options page ---------------------------------------------------------------
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForTimeout(1500);
  const optsText = (await opts.locator('body').innerText()).replace(/\s+/g, ' ');
  check('options page lists the activated scope', optsText.includes(projA), optsText.slice(0, 120));

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  if (KEEP) {
    console.log('--keep: Browser bleibt offen, Ctrl+C zum Beenden');
    await new Promise(() => {});
  }
} finally {
  if (!KEEP) await ctx.close();
}
