# Firefox e2e Runner auf geckodriver/Selenium Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run e2e:firefox` läuft die 20 gemeinsamen Real-Tenant-Checks vollständig durch, indem der Firefox-Runner von Puppeteer/WebDriver-BiDi auf klassisches WebDriver (geckodriver via `selenium-webdriver`) umgebaut wird.

**Architecture:** `scripts/e2e-checks.mjs` (die 20 Checks) und `scripts/e2e-login.mjs` bleiben unverändert — sie sprechen nur ein `driver`-Adapter-Objekt an. Ausgetauscht wird ausschließlich die Adapter-Implementierung in `scripts/e2e-firefox.mjs`: statt `puppeteer.launch({browser:'firefox'})` + `browser.installExtension()` nun `new Builder().forBrowser('firefox')` + `driver.installAddon(xpi, /*temporary*/ true)`. Selenium-Window-Handles ersetzen Puppeteer-`Page`-Objekte als „Page"-Token des Adapters.

**Tech Stack:** Node ESM, `selenium-webdriver` ^4 (neue devDependency, bringt Selenium Manager mit → geckodriver wird automatisch beschafft), System-Firefox ≥ 153.0, PowerShell `Compress-Archive` fürs XPI-Packen.

**Spec:** `docs/superpowers/plans/2026-08-13-cross-browser-testplan.md` (Task 3) + `docs/TESTPLAN.md` (§5 Checkliste, §6 Constraints)

## Warum überhaupt (Context)

Der aktuelle Firefox-Runner kommt bis zum Login und stirbt dann an einer harten Protokollgrenze: WebDriver-BiDi lehnt **jede** Navigation zu einer privilegierten URL ab —

```
unsupported operation  Navigation to "moz-extension://…/popup.html" is not allowed in this context
```

Damit sind Checks 2, 3, 4, 13, 14 (Popup), 15, 16 (Options) und **alle** `evalInExt`-Aufrufe (Storage lesen/schreiben, Scope-Keys, Settings) unerreichbar — also praktisch die ganze Suite. Verifiziert und ausgeschlossen wurden bereits:

- Pref `remote.system-access-check.enabled=false` → identischer Fehler.
- Andocken an ein Extension-Target: existiert nicht (`browser.targets()` liefert nur `browser` + `page`).
- `window.location.href = 'moz-extension://…'` aus einer Web-Seite → `Access to … denied`.

Klassisches WebDriver (geckodriver/Marionette) kennt diese Einschränkung nicht — `driver.get('moz-extension://…')` ist dort ein gewöhnlicher Navigationsbefehl. Deshalb der Umbau. Chrome (`scripts/pw-real.mjs`) bleibt unangetastet und grün.

## Global Constraints

- **Test-Tenant:** ausschließlich `fieldninjaforjira.atlassian.net`. Kein schreibender Script-Lauf gegen einen anderen Host.
- **Kein `src/`-Change.** Dieser Umbau berührt nur `scripts/`, `package.json`, `docs/`. HR-18 bleibt gültig: kein Test-Bypass in Produktivcode.
- **Keine neue Runtime-Dependency.** Dieser Plan hebt die „keine neuen Dependencies"-Regel des Vorgängerplans **ausschließlich für `devDependencies`** auf: erlaubt ist `selenium-webdriver` (^4.27). Ein separates `geckodriver`-Paket wird **nicht** installiert — Selenium Manager (in `selenium-webdriver` ≥ 4.6 enthalten) lädt den Treiber selbst.
- **Secrets:** `auth.json` (echter API-Token + Passwort) ist gitignored und darf nie committet, kopiert, geloggt oder in ein Artefakt geschrieben werden. `JIRA_EMAIL`/`JIRA_API_TOKEN` kommen aus der Umgebung.
- **Profile bleiben gitignored:** `.firefox-jira-profile/`. Fehlschlag-Screenshots heißen weiter `login-debug*.png` (bereits in `.gitignore`).
- **Locale-Falle:** Der Tenant rendert **deutsch**. Assertions nur über `data-testid`-Substrings, eigene Klassen (`.jfv-field-toggle`, `[data-jfv-hidden]`) oder Computed Style — nie über Label-/Heading-Text.
- **Nicht anfassen:** `scripts/e2e-checks.mjs`, `scripts/e2e-login.mjs`, `scripts/pw-real.mjs`, `tests/tenant.json`.

---

## File Structure

| Datei | Rolle nach dem Umbau |
|---|---|
| `scripts/e2e-checks.mjs` | **unverändert.** Die 20 Checks, browser-agnostisch hinter dem `driver`-Adapter. |
| `scripts/e2e-login.mjs` | **unverändert.** `loginIfNeeded({hasSession, sleep, type, click, waitFor})`. |
| `scripts/firefox-xpi.mjs` | **neu.** Packt `dist-firefox/` nach `.firefox-jira-profile/../field-ninja.xpi`. Exportiert `packXpi(distDir, outPath)`. Eigene Datei, weil Task 1 (Spike) und Task 2 (Runner) sie beide brauchen. |
| `scripts/e2e-firefox.mjs` | **neu geschrieben.** Selenium-Launcher + Adapter + Login-Gate + `runChecks`. |
| `scripts/spike-firefox-selenium.mjs` | **neu, temporär.** Beweisscript aus Task 1, wird in Task 4 gelöscht. |
| `package.json` | `selenium-webdriver` in `devDependencies`. Scripts bleiben namentlich gleich. |
| `docs/TESTPLAN.md` | Statusblock + §6 Constraints aktualisieren. |
| `docs/superpowers/plans/2026-08-13-cross-browser-testplan.md` | Task 3 Step 5 abhaken. |

## Der Adapter-Kontrakt (aus `scripts/e2e-checks.mjs`, wörtlich konsumiert)

`runChecks(d, tenant)` ruft ausschließlich diese 13 Funktionen auf. Das ist die vollständige Zielsignatur:

```
d.extUrl(file)              -> string
d.newPage()                 -> Promise<Page>
d.goto(p, url)              -> Promise<void>
d.wait(p, ms)               -> Promise<void>
d.count(p, sel)             -> Promise<number>
d.click(p, sel)             -> Promise<void>
d.text(p, sel)              -> Promise<string>
d.visible(p, sel)           -> Promise<boolean>
d.evalPage(p, fn)           -> Promise<any>     // fn: () => any | Promise<any>
d.consoleErrors(p)          -> string[]         // synchron!
d.close(p)                  -> Promise<void>
d.refreshPopup?.(popup, jiraPage) -> Promise<Page>
d.evalInExt(fn)             -> Promise<any>     // fn läuft im Extension-Kontext
```

`Page` ist ein opakes Token — im Selenium-Runner ist es der **Window-Handle-String**. Konstanten in den Checks: `SETTLE = 6000`, `NAV_SETTLE = 8000`, `TOGGLE = '.jfv-field-toggle'`, `HIDDEN = '[data-jfv-hidden]'`, `PREFS_KEY = 'jiraFieldVisibility:v3'`.

**Zwei Fallen, die der neue Adapter erben muss:**

1. **Overlap-Klick:** Toggle-Buttons überlappen im echten Jira-Layout. Ein Koordinaten-Klick (`element.click()` von Selenium **ist** ein Koordinaten-Klick) trifft den Nachbarn. Immer `executeScript('arguments[0].click()', el)`.
2. **Popup-Fokus:** `src/popup/popup.ts:154` macht `chrome.tabs.query({active:true, currentWindow:true})`. Das Popup als Tab ist selbst aktiv → ohne Gegenmaßnahme sieht es sich selbst statt Jira. Puppeteer konnte `jira.bringToFront()` und danach das *unfokussierte* Popup neu laden; Selenium kann nur den fokussierten Tab bedienen. Lösung: Reload im Popup **verzögert** planen, dann auf den Jira-Handle wechseln (= fokussieren), warten, zurückwechseln. Code in Task 2.

---

### Task 1: Spike — beweisen, dass geckodriver das Blocker-Problem löst

Ziel: **vor** dem Umbau praktisch bestätigen, dass (a) eine unsignierte Extension aus `dist-firefox/` installierbar ist, (b) `moz-extension://…/popup.html` navigierbar ist, (c) die UUID-Pinning-Pref unter geckodriver noch greift, (d) Console-Errors abgreifbar sind. Scheitert (b), ist der ganze Plan hinfällig — dann abbrechen und melden, nicht weiterbauen.

**Files:**
- Create: `scripts/firefox-xpi.mjs`
- Create: `scripts/spike-firefox-selenium.mjs` (temporär)
- Modify: `package.json` (devDependencies)

**Interfaces:**
- Produces: `packXpi(distDir, outPath) -> Promise<string>` (Rückgabe = `outPath`), verwendet von Task 2.

- [x] **Step 1: Dependency installieren**

```bash
npm i -D selenium-webdriver@^4.27
```

Erwartung: Installation ohne postinstall-Download. `node -e "console.log(require('selenium-webdriver/package.json').version)"` gibt eine 4.x aus. Selenium Manager beschafft geckodriver beim ersten `build()` — dafür ist einmalig Netzzugang nötig.

- [x] **Step 2: XPI-Packer schreiben**

Create `scripts/firefox-xpi.mjs`:

```js
// geckodriver's addon:install nimmt eine Datei, kein Verzeichnis. Ein XPI ist
// ein gewöhnliches ZIP, also packt PowerShell das — kein neues npm-Paket dafür.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function packXpi(distDir, outPath) {
  if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error(`${distDir}/manifest.json fehlt — erst \`npm run build:firefox\``);
  }
  fs.rmSync(outPath, { force: true });
  const zip = outPath.replace(/\.xpi$/, '.zip');
  fs.rmSync(zip, { force: true });
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${path.join(distDir, '*')}' -DestinationPath '${zip}' -Force`,
  ], { stdio: 'inherit' });
  fs.renameSync(zip, outPath);
  return outPath;
}
```

Wichtig: `-Path dist-firefox/*` (Inhalt), nicht `dist-firefox` (Ordner) — sonst liegt `manifest.json` eine Ebene zu tief und Firefox lehnt das Paket ab.

- [x] **Step 3: Spike schreiben**

Create `scripts/spike-firefox-selenium.mjs`:

```js
// Temporär. Beweist die vier Annahmen des Umbaus. Wird in Task 4 gelöscht.
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packXpi } from './firefox-xpi.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const EXT_ID = 'field-ninja@fieldninja.app';
const EXT_UUID = 'f1e1d1a1-1111-4111-8111-111111111111';

const xpi = await packXpi(path.join(ROOT, 'dist-firefox'), path.join(ROOT, 'field-ninja.xpi'));

const opts = new firefox.Options()
  .setBinary(process.env.JFV_FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe')
  .setPreference('extensions.webextensions.uuids', JSON.stringify({ [EXT_ID]: EXT_UUID }))
  .setPreference('xpinstall.signatures.required', false);
opts.enableBidi(); // nur für Console-Logs, NICHT für Navigation

const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
try {
  const id = await driver.installAddon(xpi, true); // temporary = unsigniert erlaubt
  console.log('installAddon ->', id);

  await driver.get(`moz-extension://${EXT_UUID}/popup.html`);
  console.log('url        ->', await driver.getCurrentUrl());
  console.log('title      ->', await driver.getTitle());
  console.log('#scope-label present ->', (await driver.findElements(By.css('#scope-label'))).length);

  const store = await driver.executeAsyncScript(
    'const cb=arguments[arguments.length-1];chrome.storage.sync.get(null).then(cb,e=>cb({__e:String(e)}))'
  );
  console.log('storage.sync ->', JSON.stringify(store));

  const { LogInspector } = await import('selenium-webdriver/bidi/logInspector.js');
  const insp = await LogInspector(driver);
  const seen = [];
  await insp.onConsoleEntry((e) => seen.push(`${e.level}:${e.text}`));
  await driver.executeScript('console.error("[spike] hello")');
  await new Promise((r) => setTimeout(r, 1000));
  console.log('console capture ->', JSON.stringify(seen));
} finally {
  await driver.quit();
}
```

- [x] **Step 4: Spike laufen lassen**

```bash
npm run build:firefox
node scripts/spike-firefox-selenium.mjs
```

Erwartung (alles muss stimmen):
- `installAddon -> field-ninja@fieldninja.app` (oder eine Addon-ID; kein Wurf).
- `url -> moz-extension://f1e1d1a1-…/popup.html` — **das ist der eigentliche Beweis.**
- `title` nicht leer, `#scope-label present -> 1`.
- `storage.sync -> {…}` (leeres Objekt ist ok, `__e` ist ein Fehlschlag → dann fehlt `gecko.id`).
- `console capture -> ["error:[spike] hello"]`.

Fehlerbehandlung, falls einzelne Punkte kippen:
- **`url` zeigt eine andere UUID** → die Pref greift unter geckodriver nicht. Dann UUID zur Laufzeit ermitteln statt zu pinnen: `await driver.executeScript('return browser.runtime.getURL("")')` von einer Extension-Seite aus geht nicht (Henne/Ei) — stattdessen nach `installAddon` das Profil-`prefs.js` nach `extensions.webextensions.uuids` grepen und die UUID daraus lesen. Task 2 Step 3 hält diesen Fallback vor.
- **`installAddon` wirft „not a valid xpi"** → Zip-Layout prüfen (`manifest.json` muss auf oberster Ebene liegen).
- **`moz-extension`-Navigation scheitert erneut** → Plan ist tot. Abbrechen, an den User melden, nichts weiter umbauen.
- **`console capture` leer** → nicht blockierend, siehe Task 2 Step 5 (degradierter Modus).

- [x] **Step 5: Commit**

```bash
git add scripts/firefox-xpi.mjs scripts/spike-firefox-selenium.mjs package.json package-lock.json
git commit -m "test(firefox): geckodriver spike + xpi packer"
```

`.gitignore` bekommt in Task 2 noch `field-ninja.xpi` — bis dahin die Datei nicht mit einchecken (`git status` prüfen).

---

### Task 2: Selenium-Adapter — `scripts/e2e-firefox.mjs` neu

**Files:**
- Rewrite: `scripts/e2e-firefox.mjs` (aktuell Puppeteer-BiDi, 153 Zeilen)
- Modify: `.gitignore` (eine Zeile)

**Interfaces:**
- Consumes: `packXpi` aus Task 1; `runChecks(driver, tenant)` aus `scripts/e2e-checks.mjs`; `loginIfNeeded({page, hasSession, sleep, type, click, waitFor})` aus `scripts/e2e-login.mjs`.
- Produces: das lauffähige `npm run e2e:firefox`.

- [x] **Step 1: `.gitignore` ergänzen**

Unter den bestehenden Block:

```
field-ninja.xpi
```

- [x] **Step 2: Launcher-Kopf schreiben** (umgesetzt abweichend: Firefox wird selbst gestartet, geckodriver hängt per `--connect-existing` an, Prefs über `user.js`)

Replace `scripts/e2e-firefox.mjs` komplett. Kopf:

```js
// Firefox-Gegenstück zu pw-real.mjs. Gleiche 20 Checks, gleicher Tenant.
// Klassisches WebDriver (geckodriver via selenium-webdriver), NICHT BiDi:
// BiDi verbietet jede Navigation zu moz-extension:// und damit Popup,
// Options-Seite und jeden Storage-Zugriff.
//
// Usage: node scripts/e2e-firefox.mjs [--headed]
// Requires: npm run build:firefox
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
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

const opts = new firefox.Options()
  .setBinary(process.env.JFV_FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe')
  // ponytail: -profile nutzt das Verzeichnis in-place; setProfile() würde es
  // kopieren und den frisch erzeugten MFA-Login nicht zurückschreiben.
  .addArguments('-profile', PROFILE)
  .setPreference('extensions.webextensions.uuids', JSON.stringify({ [EXT_ID]: EXT_UUID }))
  .setPreference('xpinstall.signatures.required', false);
if (!HEADED) opts.addArguments('-headless');
opts.enableBidi();

const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
await driver.installAddon(xpi, true);
const extUrl = (f) => `moz-extension://${EXT_UUID}/${f}`;
```

- [ ] **Step 3: UUID-Fallback einbauen (nur falls Task 1 Step 4 ihn nötig machte)**

Wenn der Spike gezeigt hat, dass die Pref greift: diesen Step überspringen. Sonst nach `installAddon`:

```js
// Fallback: geckodriver ignoriert die uuids-Pref → tatsächliche UUID aus dem
// Profil lesen, statt sie zu pinnen.
function readUuid() {
  const prefs = fs.readFileSync(path.join(PROFILE, 'prefs.js'), 'utf8');
  const m = prefs.match(/extensions\.webextensions\.uuids",\s*"(.*?)"\);/);
  const map = m ? JSON.parse(m[1].replace(/\\"/g, '"')) : {};
  return map[EXT_ID];
}
const uuid = readUuid() || EXT_UUID;
const extUrl = (f) => `moz-extension://${uuid}/${f}`;
```

- [x] **Step 4: Page-Primitive schreiben**

„Page" = Window-Handle-String. Jede Operation schaltet zuerst um.

```js
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
      `Promise.resolve((${fn.toString()})()).then((v)=>cb({v}),(e)=>cb({__e:String(e)}));`
  );
  if (out && out.__e) throw new Error(out.__e);
  return out ? out.v : undefined;
}
```

- [x] **Step 5: Console-Errors einsammeln** (umgesetzt abweichend: kein BiDi-Kanal unter `--connect-existing`, stattdessen injizierter Fehlersammler, degradierter Modus)

BiDi-Logs sind mit klassischer Navigation kombinierbar (nur `browsingContext.navigate` war das Problem). Attribution über die Browsing-Context-ID, die in Firefox dem Window-Handle entspricht:

```js
const errs = [];
try {
  const { LogInspector } = await import('selenium-webdriver/bidi/logInspector.js');
  const insp = await LogInspector(driver);
  await insp.onConsoleEntry((e) => {
    if (e.level === 'error') errs.push({ ctx: e.source?.context, text: e.text ?? '' });
  });
} catch (e) {
  // ponytail: ohne Log-Kanal laufen Check 12 und 20 degradiert (sie prüfen
  // Abwesenheit von Fehlern) — laut sagen, nicht still schlucken.
  console.warn('>>> DEGRADED: kein BiDi-Console-Kanal, Checks 12/20 prüfen nur die Toggle-Zahl:', String(e));
}
const consoleErrors = (h) => errs.filter((e) => !e.ctx || e.ctx === h).map((e) => e.text);
```

Wenn der Spike gezeigt hat, dass `e.source.context` **nicht** dem Handle entspricht: `!e.ctx ||` weglassen ginge dann leer aus — stattdessen auf Zeitfenster attribuieren (`errs` beim Öffnen einer Page per `errs.length`-Marke schneiden). Checks 12 und 20 öffnen jeweils einen frischen Tab und tun sonst nichts, deshalb reicht das.

- [x] **Step 6: Popup-Refresh (Fokus-Trick)**

```js
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
```

- [x] **Step 7: Adapter zusammensetzen**

```js
const adapter = {
  extUrl,
  newPage,
  goto: async (h, url) => { await use(h); await driver.get(url); },
  wait: (h, ms) => sleep(ms),
  count: async (h, sel) => { await use(h); return (await driver.findElements(By.css(sel))).length; },
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
```

- [x] **Step 8: `runChecks` verdrahten**

```js
try {
  const { passed, results, failed } = await runChecks(adapter, tenant);
  console.log(`\nfirefox: ${passed}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await driver.quit();
}
```

- [ ] **Step 9: Trockenlauf bis zum Login-Gate**

```bash
npm run build:firefox && node scripts/e2e-firefox.mjs --headed
```

Erwartung an dieser Stelle: die Checks starten und die extension-lastigen (2, 3, 15, 19) erreichen zumindest das Popup/die Options-Seite. Jira-Checks dürfen noch scheitern, solange das Login-Gate aus Task 3 fehlt. **Blocker ist nur:** irgendein `moz-extension`-Fehler.

- [x] **Step 10: Commit**

```bash
git add scripts/e2e-firefox.mjs .gitignore
git commit -m "test(firefox): drive the e2e suite through geckodriver instead of BiDi"
```

---

### Task 3: Login-Gate und voller headless-Lauf

**Files:**
- Modify: `scripts/e2e-firefox.mjs` (Block zwischen `installAddon` und `runChecks`)

**Interfaces:**
- Consumes: `loginIfNeeded` aus `scripts/e2e-login.mjs` — Signatur `({ page, hasSession, sleep, type, click, waitFor }) -> Promise<boolean>`; die Selektorlisten (`#username`, `#password`, `#login-submit`, …) stecken dort drin und werden **nicht** dupliziert.

- [x] **Step 1: Session-Erkennung**

```js
// Der Hostname ist kein Login-Signal — nur das session.token-Cookie zählt.
// Selenium liefert Cookies der aktuellen Domain, also erst zum Tenant navigieren.
const hasSession = async () =>
  (await driver.manage().getCookies()).some((c) => /session\.token/.test(c.name));
```

- [x] **Step 2: Gate einbauen (vor `runChecks`)**

```js
{
  const h = await newPage();
  await driver.get(`${ORIGIN}/jira/your-work`);
  await sleep(3000);
  if (!(await hasSession())) {
    const ok = await loginIfNeeded({
      page: h,
      hasSession,
      sleep,
      type: async (sel, text) => { const el = await one(h, sel); await el.sendKeys(text); },
      click: async (sel) => { const el = await one(h, sel); await driver.executeScript('arguments[0].click()', el); },
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
      await driver.quit();
      console.error(
        (HEADED
          ? `\n>>> Kein Login im Profil für ${tenant.host} — bitte im Fenster anmelden und erneut starten.\n`
          : '\n>>> Kein Login im .firefox-jira-profile/. Einmalig `node scripts/e2e-firefox.mjs --headed` laufen lassen und dort anmelden.\n') +
          '>>> Auto-Login fehlgeschlagen (fehlende/falsche auth.json, MFA oder Captcha?).\n'
      );
      process.exit(1);
    }
  }
  await adapter.close(h);
}
```

Reihenfolge beachten: dieser Block braucht `adapter` → er steht **nach** Task 2 Step 7 und **vor** Step 8. `one()` und `newPage()` sind zu dem Zeitpunkt definiert.

- [x] **Step 3: Einmaliger headed Login**

```bash
node scripts/e2e-firefox.mjs --headed
```

MFA-Code im Fenster eintippen. Gotcha aus dem Chrome-Lauf: Das `session.token`-Cookie erscheint erst, nachdem der **Tenant-Host selbst** besucht wurde — endet der Lauf auf `home.atlassian.com`, einfach neu starten.

- [x] **Step 4: Voller headless-Lauf** (laut Commit 5116fc8: 20/20 headless; nicht erneut gemessen)

```bash
npm run e2e:firefox
```

Erwartung: `firefox: 20/20 passed` (Check 18 SKIPt, solange `FNCM-1` kein Cover-Bild hat — bekannt, kein Fehlschlag).

Wenn einzelne Checks kippen, in dieser Reihenfolge prüfen:
- **2/13 (`#scope-label`)** → Fokus-Trick aus Task 2 Step 6; `sleep`-Werte dort erhöhen.
- **4 (Toggles ohne Reload)** → SPA braucht Zeit; die Checks nutzen bereits `SETTLE=6000`.
- **6/7 (Klick wirkt nicht)** → Overlap-Falle; sicherstellen, dass `click` über `executeScript` läuft, nicht über `el.click()`.
- **10 (SPA-Nav)** → `watchIssueContext` pollt `location.href` alle 300 ms; ein `driver.get()` ist **kein** SPA-Wechsel, ein Klick auf eine Navigator-Zeile schon (macht `e2e-checks.mjs` bereits richtig — hier nichts anpassen).
- **12/20** → siehe degradierter Console-Modus, Task 2 Step 5.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-firefox.mjs
git commit -m "test(firefox): reuse the shared auto-login in the selenium runner"
```

---

### Task 4: Aufräumen und Doku

**Files:**
- Delete: `scripts/spike-firefox-selenium.mjs`
- Modify: `docs/TESTPLAN.md:6-16` (Statusblock), `:24` (Layer-Tabelle), `:106-119` (§6)
- Modify: `docs/superpowers/plans/2026-08-13-cross-browser-testplan.md` (Task 3 Step 5)
- Modify: `package.json` — nur prüfen, nicht ändern: `e2e:firefox` zeigt weiter auf `node scripts/e2e-firefox.mjs`.

- [ ] **Step 1: Spike löschen**

```bash
git rm scripts/spike-firefox-selenium.mjs
```

`puppeteer` bleibt als devDependency — `tests/integration/` benutzt es weiter. Nicht deinstallieren.

- [ ] **Step 2: `docs/TESTPLAN.md` Statusblock ersetzen**

```markdown
**Status (2026-08-14):**

- **Chrome: green.** `npm run e2e:chrome` runs headless and reports
  `chrome: 20/20 passed` (check 18 SKIPs until the cover image of §2 exists).
- **Firefox: green.** `npm run e2e:firefox` runs headless via geckodriver
  (`selenium-webdriver`) and reports `firefox: 20/20 passed`.
```

In der Layer-Tabelle (Zeile 24) `Puppeteer BiDi (Firefox)` → `Selenium/geckodriver (Firefox)`.

- [ ] **Step 3: `docs/TESTPLAN.md` §6 Constraints ersetzen**

Den Playwright-/Puppeteer-Punkt ersetzen durch:

```markdown
- Playwright kann keine unsignierten Firefox-Add-ons installieren; WebDriver-BiDi
  (Puppeteer ≥24) kann es zwar, verbietet aber jede Navigation zu
  `moz-extension://…` ("unsupported operation … not allowed in this context") —
  damit sind Popup, Options-Seite und Storage unerreichbar. Der Firefox-Runner
  nutzt deshalb klassisches WebDriver über `selenium-webdriver` + geckodriver
  (Selenium Manager beschafft den Treiber). Die Extension wird als temporäres,
  unsigniertes XPI installiert (`scripts/firefox-xpi.mjs` packt `dist-firefox/`).
```

Und §2 (One-time setup) Zeile 34: `node scripts/e2e-firefox.mjs --headed` bleibt korrekt — nur prüfen.

- [ ] **Step 4: Vorgängerplan abhaken**

In `docs/superpowers/plans/2026-08-13-cross-browser-testplan.md` Task 3 Step 5 auf `- [x]` setzen, Blocker-Annotation ersetzen durch „gelöst durch geckodriver-Umbau, siehe `2026-08-14-firefox-selenium-runner.md`".

- [ ] **Step 5: Gesamtlauf als Abnahme**

```bash
npm test && npm run e2e
```

Erwartung: Unit + Integration grün, `chrome: 20/20 passed`, `firefox: 20/20 passed`.

- [ ] **Step 6: Reviewer + Commit**

`@reviewer` auf den Diff ansetzen (Projektregel: nach jeder Änderung, vor dem Commit). Besonders prüfen: keine Credentials in Logs/Screenshot-Pfaden, `field-ninja.xpi` und `login-debug*.png` gitignored, kein `src/`-Change.

```bash
git add -A
git commit -m "docs(testplan): firefox e2e runs headless via geckodriver"
```

---

## Verification

| Was | Wie | Erwartung |
|---|---|---|
| Blocker gelöst | Task 1 Step 4 | `url -> moz-extension://…/popup.html` |
| Adapter vollständig | Task 3 Step 4 | `firefox: 20/20 passed` (18 SKIP ok) |
| Chrome unbeschädigt | `npm run e2e:chrome` | `chrome: 20/20 passed` |
| Offline-Suite unbeschädigt | `npm test` | 7 Unit + 10 Integration grün |
| Keine Secrets im Repo | `git status` nach jedem Task | weder `auth.json`, `field-ninja.xpi`, `login-debug-firefox.png` noch `.firefox-jira-profile/` auftauchend |

## Bekannte offene Punkte (nicht Teil dieses Plans)

- `FNCM-1` braucht ein manuell angehängtes Cover-Bild, sonst SKIPt Check 18 dauerhaft (kein REST-Endpunkt dafür).
- Der Spike ist **nicht** vorab verifiziert: `installAddon` mit Verzeichnis vs. XPI und das UUID-Pinning unter geckodriver sind begründete Annahmen, keine Messungen. Task 1 existiert genau deshalb — kippt sie an Punkt (b), ist der Umbau nicht machbar und der Rest des Plans entfällt.
