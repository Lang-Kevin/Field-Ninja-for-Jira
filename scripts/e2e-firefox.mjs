// Firefox-Gegenstück zu pw-real.mjs. Gleiche 20 Checks, gleicher Tenant.
// Klassisches WebDriver (geckodriver via selenium-webdriver), NICHT BiDi:
// BiDi verbietet jede Navigation zu moz-extension:// und damit Popup,
// Options-Seite und jeden Storage-Zugriff.
//
// Marionette verbietet sie ebenfalls — es sei denn, Firefox selbst startet mit
// -remote-allow-system-access. Dieses Argument akzeptiert geckodriver nicht
// über die Capabilities ("can't be set via capabilities"), also startet dieses
// Script Firefox selbst und hängt geckodriver per --connect-existing an.
//
// Usage: node scripts/e2e-firefox.mjs [--headed]
// Requires: npm run build:firefox
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './e2e-checks.mjs';
import { loginIfNeeded } from './e2e-login.mjs';
import { packXpi } from './firefox-xpi.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist-firefox');
const PROFILE = path.join(ROOT, '.firefox-jira-profile');
const EXT_ID = 'field-ninja@fieldninja.app';
const EXT_UUID = 'f1e1d1a1-1111-4111-8111-111111111111';
const MARIONETTE_PORT = Number(process.env.JFV_MARIONETTE_PORT || 2828);
const tenant = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/tenant.json'), 'utf8'));
const HEADED = process.argv.includes('--headed');
const ORIGIN = `https://${tenant.host}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// gecko.id ist load-bearing: ohne ihn verweigert Firefox storage.sync.
const mf = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
if (mf.browser_specific_settings?.gecko?.id !== EXT_ID) {
  console.error(`dist-firefox manifest gecko.id != ${EXT_ID}`);
  process.exit(1);
}
const xpi = await packXpi(DIST, path.join(ROOT, 'field-ninja.xpi'));

// Prefs gehen über user.js ins Profil — setPreference() greift nur, wenn
// geckodriver Firefox startet, und das tut es hier nicht. Das Profil selbst
// bleibt bestehen, sonst wäre der einmalige MFA-Login jedes Mal weg.
fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(
  path.join(PROFILE, 'user.js'),
  [
    `user_pref("extensions.webextensions.uuids", "${JSON.stringify({ [EXT_ID]: EXT_UUID }).replace(/"/g, '\\"')}");`,
    'user_pref("xpinstall.signatures.required", false);',
    `user_pref("marionette.port", ${MARIONETTE_PORT});`,
    'user_pref("remote.prefs.recommended", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
  ].join('\n'),
);

const ffArgs = ['-marionette', '-remote-allow-system-access', '-no-remote', '-profile', PROFILE];
if (!HEADED) ffArgs.push('-headless');
const ff = spawn(process.env.JFV_FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe', ffArgs, {
  stdio: 'ignore',
});

// Auf den Marionette-Port warten statt blind zu schlafen.
for (let i = 0; i < 60; i++) {
  const up = await new Promise((res) => {
    const s = net.connect(MARIONETTE_PORT, '127.0.0.1');
    s.on('connect', () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
  });
  if (up) break;
  if (i === 59) {
    ff.kill();
    console.error(`>>> Firefox hat Marionette auf Port ${MARIONETTE_PORT} nicht geöffnet.`);
    process.exit(1);
  }
  await sleep(500);
}

const svc = new firefox.ServiceBuilder().addArguments(
  '--connect-existing',
  '--marionette-port',
  String(MARIONETTE_PORT),
);
const driver = await new Builder().forBrowser('firefox').setFirefoxService(svc).build();
await driver.installAddon(xpi, true);
const extUrl = (f) => `moz-extension://${EXT_UUID}/${f}`;

const use = (h) => driver.switchTo().window(h);

async function newPage() {
  await driver.switchTo().newWindow('tab');
  return driver.getWindowHandle();
}
async function one(h, sel) {
  await use(h);
  return (await driver.findElements(By.css(sel)))[0];
}
// executeScript awaitet keine Promises — deshalb generell der Async-Wrapper.
async function run(h, fn) {
  await use(h);
  const out = await driver.executeAsyncScript(
    `const cb=arguments[arguments.length-1];` +
      `Promise.resolve((${fn.toString()})()).then((v)=>cb({v}),(e)=>cb({__e:String(e)}));`,
  );
  if (out && out.__e) throw new Error(out.__e);
  return out ? out.v : undefined;
}

// ponytail: --connect-existing kennt keinen BiDi-Kanal, also lesen die Checks
// 12/20 die Fehler aus einem in die Seite injizierten Sammler. Der hängt sich
// nach dem Laden ein und sieht damit nur Fehler ab diesem Moment — für beide
// Checks reicht das, sie öffnen einen frischen Tab und warten danach.
const HOOK = `if(!window.__jfvErrs){window.__jfvErrs=[];const o=console.error;` +
  `console.error=function(...a){window.__jfvErrs.push(a.join(' '));return o.apply(console,a)};` +
  `addEventListener('error',(e)=>window.__jfvErrs.push(String(e.message)))}`;
console.warn(
  '>>> DEGRADED: kein BiDi-Console-Kanal (--connect-existing kennt keinen).\n' +
    '>>> Checks 12/20 sehen nur Fehler der Seite selbst, nicht die der Content-Script-Welt.',
);
const errCache = new Map();
async function pullErrors(h) {
  try {
    await use(h);
    const got = await driver.executeScript('return window.__jfvErrs || []');
    errCache.set(h, got);
  } catch {
    /* Tab weg oder privilegierter Kontext — alten Stand behalten */
  }
}
const consoleErrors = (h) => errCache.get(h) || [];

// popup.ts:154 fragt tabs.query({active:true,currentWindow:true}). Selenium kann
// nur den fokussierten Tab bedienen, also den Reload vorplanen und währenddessen
// zu Jira wechseln — dann sieht das Popup beim Laden Jira als aktiven Tab.
async function refreshPopup(popup, jiraPage) {
  await use(popup);
  if (!(await driver.getCurrentUrl()).startsWith(extUrl('popup.html'))) {
    await driver.get(extUrl('popup.html'));
  }
  await driver.executeScript('setTimeout(() => location.reload(), 800)');
  await use(jiraPage);
  await sleep(2000);
  await use(popup);
  await sleep(600);
  return popup;
}

const adapter = {
  extUrl,
  newPage,
  goto: async (h, url) => {
    await use(h);
    await driver.get(url);
    await driver.executeScript(HOOK).catch(() => {});
  },
  wait: async (h, ms) => {
    await sleep(ms);
    await pullErrors(h);
  },
  count: async (h, sel) => {
    await use(h);
    return (await driver.findElements(By.css(sel))).length;
  },
  // Gleiche Overlap-Falle wie in pw-real.mjs: Selenium's el.click() klickt über
  // Koordinaten und trifft den Nachbar-Toggle. Direkt aufs Element.
  click: async (h, sel) => {
    const el = await one(h, sel);
    if (!el) throw new Error(`kein Element ${sel}`);
    await driver.executeScript('arguments[0].click()', el);
  },
  text: async (h, sel) => {
    const el = await one(h, sel);
    // getText() liefert '' für unsichtbare Knoten — textContent ist robuster.
    return el ? String(await driver.executeScript('return arguments[0].textContent', el)).trim() : '';
  },
  visible: async (h, sel) => {
    const el = await one(h, sel);
    return el ? el.isDisplayed().catch(() => false) : false;
  },
  evalPage: (h, fn) => run(h, fn),
  consoleErrors,
  close: async (h) => {
    await pullErrors(h);
    await use(h);
    await driver.close();
    const rest = await driver.getAllWindowHandles();
    if (rest.length) await use(rest[0]);
  },
  refreshPopup,
  async evalInExt(fn) {
    const h = await newPage();
    await driver.get(extUrl('popup.html'));
    const out = await run(h, fn);
    await adapter.close(h);
    return out;
  },
};

// Der Hostname ist kein Login-Signal — nur das session.token-Cookie zählt.
// Selenium liefert Cookies der aktuellen Domain, also erst zum Tenant navigieren.
const hasSession = async () =>
  (await driver.manage().getCookies()).some((c) => /session\.token/.test(c.name) && (!c.expiry || c.expiry > Date.now() / 1000));

{
  const h = await newPage();
  await driver.get(`${ORIGIN}/jira/your-work`);
  await sleep(3000);
  if (!(await hasSession())) {
    const ok = await loginIfNeeded({
      page: h,
      hasSession,
      sleep,
      type: async (sel, text) => {
        const el = await one(h, sel);
        await el.sendKeys(text);
      },
      click: async (sel) => {
        const el = await one(h, sel);
        await driver.executeScript('arguments[0].click()', el);
      },
      waitFor: async (sel, timeoutMs) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          if (await one(h, sel)) return true;
          await sleep(250);
        }
        return false;
      },
    });
    // Der Account erzwingt E-Mail-MFA: E-Mail + Passwort laufen automatisch,
    // der Code muss einmal pro Profil von Hand ins Fenster.
    if (!ok && HEADED) {
      console.log('\n>>> Auto-Login hat E-Mail + Passwort gesetzt. Bitte MFA-Code im Fenster eingeben (max 10 min).\n');
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline && !(await hasSession())) await sleep(3000);
    }
    if (!(await hasSession())) {
      const png = await driver.takeScreenshot().catch(() => null);
      if (png) fs.writeFileSync(path.join(ROOT, 'login-debug-firefox.png'), png, 'base64');
      console.error(`>>> URL beim Abbruch: ${await driver.getCurrentUrl()} — Screenshot: login-debug-firefox.png`);
      await driver.quit().catch(() => {});
      ff.kill();
      console.error(
        (HEADED
          ? `\n>>> Kein Login im Profil für ${tenant.host} — bitte im Fenster anmelden und erneut starten.\n`
          : '\n>>> Kein Login im .firefox-jira-profile/. Einmalig `node scripts/e2e-firefox.mjs --headed` laufen lassen und dort anmelden.\n') +
          '>>> Auto-Login fehlgeschlagen (fehlende/falsche auth.json, MFA oder Captcha?).\n',
      );
      process.exit(1);
    }
  }
  await adapter.close(h);
}

try {
  const { passed, results, failed } = await runChecks(adapter, tenant);
  console.log(`\nfirefox: ${passed}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await driver.quit().catch(() => {});
  ff.kill();
}
