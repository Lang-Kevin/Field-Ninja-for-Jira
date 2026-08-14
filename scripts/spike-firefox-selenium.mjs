import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packXpi } from './firefox-xpi.mjs';
const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const EXT_ID = 'field-ninja@fieldninja.app';
const EXT_UUID = 'f1e1d1a1-1111-4111-8111-111111111111';
const PROFILE = path.join(ROOT, '.ff-spike-profile');
const xpi = await packXpi(path.join(ROOT, 'dist-firefox'), path.join(ROOT, 'field-ninja.xpi'));
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'user.js'), [
  `user_pref("extensions.webextensions.uuids", "${JSON.stringify({[EXT_ID]:EXT_UUID}).replace(/"/g,'\\"')}");`,
  'user_pref("xpinstall.signatures.required", false);',
  'user_pref("marionette.port", 2828);',
  'user_pref("remote.prefs.recommended", true);',
].join('\n'));
const bin = process.env.JFV_FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe';
const ff = spawn(bin, ['-marionette', '-remote-allow-system-access', '-headless', '-no-remote', '-profile', PROFILE], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 5000));
const svc = new firefox.ServiceBuilder().addArguments('--connect-existing', '--marionette-port', '2828');
const driver = await new Builder().forBrowser('firefox').setFirefoxService(svc).build();
try {
  console.log('installAddon ->', await driver.installAddon(xpi, true));
  await driver.get(`moz-extension://${EXT_UUID}/popup.html`);
  console.log('url   ->', await driver.getCurrentUrl());
  console.log('title ->', await driver.getTitle());
  console.log('#scope-label ->', (await driver.findElements(By.css('#scope-label'))).length);
  const store = await driver.executeAsyncScript('const cb=arguments[arguments.length-1];chrome.storage.sync.get(null).then(cb,e=>cb({__e:String(e)}))');
  console.log('storage.sync ->', JSON.stringify(store));
} catch (e) { console.log('FAIL:', e.name, e.message); }
finally { await driver.quit().catch(()=>{}); ff.kill(); }
