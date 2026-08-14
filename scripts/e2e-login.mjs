// Shared auto-login for the two e2e runners (pw-real.mjs, e2e-firefox.mjs).
// Reads credentials from the gitignored auth.json at the repo root and drives
// the Atlassian id.atlassian.com login flow. Browser-specific primitives
// (type/click/waitFor) are supplied by the caller so this file stays
// Playwright/Puppeteer agnostic. Never logs credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * @param {{
 *   page: unknown,
 *   hasSession: () => Promise<boolean>,
 *   sleep: (ms: number) => Promise<void>,
 *   type: (sel: string, text: string) => Promise<void>,
 *   click: (sel: string) => Promise<void>,
 *   waitFor: (sel: string, timeoutMs?: number) => Promise<boolean>,
 * }} args
 */
export async function loginIfNeeded({ hasSession, sleep, type, click, waitFor }) {
  if (await hasSession()) return true;

  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(path.join(ROOT, 'auth.json'), 'utf8'));
  } catch {
    return false;
  }
  if (!auth?.name || !auth?.password) return false;

  // Atlassian rendert das Login-Formular je nach Flow mit anderen IDs.
  const first = async (sels, ms) => {
    for (const s of sels) if (await waitFor(s, ms)) return s;
    return null;
  };
  const EMAIL = ['#username', 'input[name="username"]', 'input[type="email"]'];
  const PASSWORD = ['#password', 'input[name="password"]', 'input[type="password"]'];
  const SUBMIT = ['#login-submit', 'button[type="submit"]'];

  const email = await first(EMAIL, 15000);
  if (!email) return await hasSession();
  await type(email, auth.name);
  const submit1 = await first(SUBMIT, 3000);
  if (!submit1) return await hasSession();
  await click(submit1);

  await sleep(3000);
  const password = await first(PASSWORD, 15000);
  if (!password) return await hasSession();
  await type(password, auth.password);
  const submit2 = await first(SUBMIT, 3000);
  if (!submit2) return await hasSession();
  await click(submit2);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await hasSession()) return true;
    await sleep(1000);
  }
  return false;
}
