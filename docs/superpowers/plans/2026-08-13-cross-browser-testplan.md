# Cross-Browser Test Plan (Chrome + Firefox) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repeatable, mostly-headless end-to-end test suite for Field Ninja for Jira that runs the real built extension against a real Jira tenant (`fieldninjaforjira.atlassian.net`) in both Chrome and Firefox, with the tenant itself provisioned by script.

**Architecture:** Three layers, each in its own file. (1) `scripts/jira-seed.mjs` provisions the test tenant idempotently over the Jira REST API. (2) `scripts/e2e-checks.mjs` holds the browser-agnostic assertion suite behind a tiny page-driver adapter. (3) Two thin launchers — `scripts/pw-real.mjs` (existing, Chrome, playwright-core, refactored to consume the shared suite) and `scripts/e2e-firefox.mjs` (new, Puppeteer WebDriver-BiDi, headless Firefox, temp-addon install with a pinned `moz-extension://` UUID).

**Tech Stack:** Node ESM, `playwright-core` (Chrome for Testing), `puppeteer` ≥24 (Firefox via BiDi), Jira Cloud REST API v3, existing `vitest` suites untouched.

**Spec:** `docs/SPEC.md` (features §1–§6, hard rules HR-3/8/9/12/16/17/18, build parity §12, test contract §10)

## Context

The repo already has strong offline coverage: 7 vitest unit specs and 10 Puppeteer integration specs driving static Jira fixtures (`tests/fixtures/*.html`) with the unpacked `dist/` loaded. What it has never had is a stable **real-tenant** target. `scripts/pw-real.mjs` exists and does the right thing (headless Chrome, real login, real DOM), but it points at an arbitrary tenant, discovers projects by scraping markup, and has zero Firefox counterpart — so `dist-firefox/` (shipped since 0.4.0) has never been verified end-to-end at all.

The user has now provided a disposable tenant, `https://fieldninjaforjira.atlassian.net`, explicitly safe to write to. That makes the missing layer buildable: a seeded, known-shape tenant turns `pw-real.mjs`'s guesswork into deterministic assertions, and the same assertion suite can then be pointed at Firefox to prove build parity.

**Note on Playwright MCP:** the request asked for Playwright MCP in headless mode. The MCP server disconnected during planning, and it would not have been the right tool anyway: an MCP-driven browser launches without `--load-extension`, so it can only see Jira's DOM, never the extension's toggles — the same limitation `CLAUDE.md` already records for `agent-browser`. This plan therefore drives headless browsers through local `playwright-core` / `puppeteer` scripts, which *can* load the extension. Everything except the one-time Jira login and the one-time cover-image upload stays headless.

## Global Constraints

Copied verbatim from `docs/SPEC.md` and `CLAUDE.md`; every task inherits these.

- Test tenant: `fieldninjaforjira.atlassian.net`. Never point write-capable scripts at any other host.
- HR-18: no localhost/test bypass may be added to production code under `src/`. Test-only widening happens on a **copy** of the manifest (see `tests/integration/setup.ts:11-28`) — never in `manifest.json`.
- Storage keys are fixed: `jiraFieldVisibility:v3`, `jiraFieldVisibility:settings:v1`, `jiraFieldVisibility:activations:v1` (`src/types/prefs.ts:40,53,41`).
- Activation scope key format: `` `${host}:${projectKey}` `` where host has no port (`src/types/prefs.ts:16-18`).
- Protected fields (Summary, Status) get no toggle button and can never be hidden (`src/lib/ui-overlay.ts:81-83`, `src/lib/visibility-engine.ts:64`).
- URL eligibility gate: hostname ends `.atlassian.net` AND path starts `/browse/` or `/jira/`, or is `/issues` / `/issues/…` (`src/lib/jira-context-resolver.ts:36-52`).
- Firefox build requires `browser_specific_settings.gecko.id = "field-ninja@fieldninja.app"`, `strict_min_version 153.0` (`manifest.firefox.json`). Without the gecko id, `storage.sync` is unavailable — the whole product breaks.
- Both builds must be rebuilt before any e2e run: `npm run build && npm run build:firefox`.
- Secrets (`JIRA_EMAIL`, `JIRA_API_TOKEN`) come from the environment only. Never commit them; `.playwright-jira-profile/` and any `.env` stay gitignored.
- No new runtime dependency for `src/`. The only dependency change permitted by this plan is the `puppeteer` devDependency bump in Task 3.

---

### Task 0: Move this plan into the repo

**Files:**
- Create: `docs/superpowers/plans/2026-08-13-cross-browser-testplan.md`

- [x] **Step 1: Copy this plan file into the project**

Project rule (`CLAUDE.md` → Plan Storage) keeps plans inside the repo. Copy the contents of this file to `docs/superpowers/plans/2026-08-13-cross-browser-testplan.md` and work from there.

- [x] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-08-13-cross-browser-testplan.md
git commit -m "docs: add cross-browser e2e test plan"
```

---

### Task 1: Tenant provisioning script

**Files:**
- Create: `scripts/jira-seed.mjs`
- Modify: `package.json` (add `seed:jira` script)
- Modify: `.gitignore` (add `.env`)
- Test: `scripts/jira-seed.mjs --dry-run` (self-check, no vitest — this talks to a live tenant)

**Interfaces:**
- Consumes: nothing.
- Produces: a tenant with the exact shape below, and a machine-readable summary written to `tests/tenant.json`:
  ```json
  {
    "host": "fieldninjaforjira.atlassian.net",
    "projects": {
      "FNCM": { "style": "classic", "issueTypes": ["Task","Bug","Story","Epic"], "sampleIssues": {"Task":"FNCM-1","Bug":"FNCM-2","Story":"FNCM-3","Epic":"FNCM-4"} },
      "FNTM": { "style": "next-gen", "issueTypes": ["Task","Bug"], "sampleIssues": {"Task":"FNTM-1","Bug":"FNTM-2"} }
    },
    "customFields": [{ "name": "FN Text", "id": "customfield_10050" }]
  }
  ```
  Task 2 and Task 3 both read `tests/tenant.json`; nothing else may hardcode project keys.

**Target tenant shape** (why: `FNCM` is company-managed so custom fields can be attached to a screen over REST; `FNTM` is team-managed, which is the layout `jira-context-resolver.ts` historically struggled with, and it proves project-scoped activation is really per-project):

| Project | Key | Style | Issue types | Extra fields |
|---|---|---|---|---|
| Field Ninja CM | `FNCM` | company-managed (`classic`) | Task, Bug, Story, Epic | 6 custom fields, all on the default screen |
| Field Ninja TM | `FNTM` | team-managed (`next-gen`) | Task, Bug | defaults only |

Six custom fields on `FNCM`, chosen to cover every branch of `src/lib/field-id.ts:63-99` (customfield token, testid, aria-label slug, label hash) and every container shape in `field-registry.ts`:

| Name | Type schema |
|---|---|
| FN Text | `com.atlassian.jira.plugin.system.customfieldtypes:textfield` |
| FN Paragraph | `…:textarea` |
| FN Select | `…:select` (options: Alpha, Beta, Gamma) |
| FN User | `…:userpicker` |
| FN Date | `…:datepicker` |
| FN Labels | `…:labels` |

- [x] **Step 1: Write the script**

Create `scripts/jira-seed.mjs`. Everything is idempotent: each create is preceded by a lookup, and an existing object is reused, never duplicated. Rerunning after a tenant wipe must produce the same `tests/tenant.json`.

```js
// Seeds the disposable test tenant into the exact shape the e2e suites expect.
// Idempotent: safe to re-run. Writes tests/tenant.json for the e2e launchers.
//
// Usage:
//   JIRA_EMAIL=... JIRA_API_TOKEN=... node scripts/jira-seed.mjs [--dry-run]
// Token: https://id.atlassian.com/manage-profile/security/api-tokens
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOST = process.env.JFV_JIRA_HOST || 'fieldninjaforjira.atlassian.net';
const DRY = process.argv.includes('--dry-run');
const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error('set JIRA_EMAIL and JIRA_API_TOKEN');
  process.exit(1);
}
// Guard: this script CREATES and MODIFIES. Never let it point at a real tenant.
if (HOST !== 'fieldninjaforjira.atlassian.net' && !process.argv.includes('--i-know')) {
  console.error(`refusing to write to ${HOST} without --i-know`);
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
async function api(method, urlPath, body) {
  if (DRY && method !== 'GET') {
    console.log(`DRY  ${method} ${urlPath}`);
    return {};
  }
  const res = await fetch(`https://${HOST}${urlPath}`, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const me = await api('GET', '/rest/api/3/myself');
console.log(`authenticated as ${me.emailAddress} (${me.accountId})`);

// --- projects ---------------------------------------------------------------
async function ensureProject(key, name, templateKey, style) {
  const existing = await api('GET', `/rest/api/3/project/search?query=${key}`);
  const hit = existing.values?.find((p) => p.key === key);
  if (hit) {
    console.log(`project ${key} exists`);
    return hit;
  }
  console.log(`creating project ${key} (${style})`);
  return api('POST', '/rest/api/3/project', {
    key,
    name,
    projectTypeKey: 'software',
    projectTemplateKey: templateKey,
    leadAccountId: me.accountId,
    assigneeType: 'PROJECT_LEAD',
  });
}

await ensureProject(
  'FNCM', 'Field Ninja CM',
  'com.pyxis.greenhopper.jira:gh-simplified-scrum-classic', 'classic'
);
await ensureProject(
  'FNTM', 'Field Ninja TM',
  'com.pyxis.greenhopper.jira:gh-simplified-agility-kanban', 'next-gen'
);

// --- custom fields (FNCM only; team-managed fields are UI-only) --------------
const FIELD_DEFS = [
  ['FN Text', 'textfield', 'textfield'],
  ['FN Paragraph', 'textarea', 'textarea'],
  ['FN Select', 'select', 'multiselectsearcher'],
  ['FN User', 'userpicker', 'userpickergroupsearcher'],
  ['FN Date', 'datepicker', 'daterange'],
  ['FN Labels', 'labels', 'labelsearcher'],
];
const P = 'com.atlassian.jira.plugin.system.customfieldtypes:';
const allFields = await api('GET', '/rest/api/3/field');
const customFields = [];
for (const [name, type, searcher] of FIELD_DEFS) {
  let f = allFields.find((x) => x.name === name && x.custom);
  if (!f) {
    console.log(`creating field ${name}`);
    f = await api('POST', '/rest/api/3/field', {
      name,
      type: P + type,
      searcherKey: P + searcher,
      description: 'Field Ninja e2e test field',
    });
  }
  customFields.push({ name, id: f.id ?? 'dry-run' });
}

// Attach to the default screen's first tab, else the fields never render on the
// issue view and every toggle assertion downstream fails for the wrong reason.
if (!DRY) {
  const screens = await api('GET', '/rest/api/3/screens?queryString=Default');
  const screen = screens.values?.[0];
  if (!screen) throw new Error('no default screen found — attach fields manually');
  const tabs = await api('GET', `/rest/api/3/screens/${screen.id}/tabs`);
  const tabId = tabs[0].id;
  const onTab = await api('GET', `/rest/api/3/screens/${screen.id}/tabs/${tabId}/fields`);
  for (const cf of customFields) {
    if (onTab.some((x) => x.id === cf.id)) continue;
    console.log(`adding ${cf.name} to screen ${screen.id}`);
    await api('POST', `/rest/api/3/screens/${screen.id}/tabs/${tabId}/fields`, { fieldId: cf.id });
  }
}

// --- issues ------------------------------------------------------------------
const WANT = { FNCM: ['Task', 'Bug', 'Story', 'Epic'], FNTM: ['Task', 'Bug'] };
const tenant = { host: HOST, projects: {}, customFields };

for (const [key, types] of Object.entries(WANT)) {
  const meta = await api('GET', `/rest/api/3/issue/createmeta?projectKeys=${key}&expand=projects.issuetypes`);
  const available = meta.projects?.[0]?.issuetypes ?? [];
  const sampleIssues = {};
  for (const t of types) {
    const it = available.find((x) => x.name === t);
    if (!it) {
      console.log(`SKIP ${key}/${t} — issue type not in this project`);
      continue;
    }
    const summary = `[e2e] ${key} ${t} sample`;
    const found = await api(
      'GET',
      `/rest/api/3/search?jql=${encodeURIComponent(`project=${key} AND summary~"\\"${summary}\\"" ORDER BY created ASC`)}&maxResults=1`
    );
    let issueKey = found.issues?.[0]?.key;
    if (!issueKey) {
      console.log(`creating ${key}/${t}`);
      const created = await api('POST', '/rest/api/3/issue', {
        fields: {
          project: { key },
          issuetype: { id: it.id },
          summary,
          description: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Field Ninja e2e fixture issue.' }] }],
          },
        },
      });
      issueKey = created.key ?? 'DRY-0';
    }
    sampleIssues[t] = issueKey;
  }
  tenant.projects[key] = { style: key === 'FNCM' ? 'classic' : 'next-gen', issueTypes: types, sampleIssues };
}

// Populate the FNCM Task's custom fields so they actually render (empty fields
// on some layouts collapse and produce no container).
const cmTask = tenant.projects.FNCM?.sampleIssues?.Task;
if (cmTask && !DRY) {
  const byName = Object.fromEntries(customFields.map((f) => [f.name, f.id]));
  await api('PUT', `/rest/api/3/issue/${cmTask}`, {
    fields: {
      [byName['FN Text']]: 'ninja',
      [byName['FN Date']]: '2026-01-15',
      [byName['FN Labels']]: ['e2e', 'fieldninja'],
    },
  }).catch((e) => console.log(`WARN could not set custom field values: ${e.message}`));
}

fs.writeFileSync(path.join(ROOT, 'tests/tenant.json'), JSON.stringify(tenant, null, 2) + '\n');
console.log('\nwrote tests/tenant.json');
console.log(JSON.stringify(tenant, null, 2));
```

- [x] **Step 2: Run the dry run and verify it authenticates**

```bash
export JIRA_EMAIL='kevinlangprivat@gmail.com'
export JIRA_API_TOKEN='<token from id.atlassian.com/manage-profile/security/api-tokens>'
node scripts/jira-seed.mjs --dry-run
```

Expected: `authenticated as … (accountId)`, then a list of `DRY POST …` lines. If it prints `401`, the token is wrong. If it prints `403` on `/rest/api/3/field`, the account is not a Jira admin on the tenant — stop and tell the user; nothing downstream works without admin.

- [x] **Step 3: Run it for real**

```bash
node scripts/jira-seed.mjs
```

Expected: projects created (or "exists"), 6 fields created, fields added to screen, issues created, `tests/tenant.json` written with real issue keys.

- [x] **Step 4: Run it a second time to prove idempotency**

```bash
node scripts/jira-seed.mjs
```

Expected: every line says "exists" or is silent; no `creating` lines; `tests/tenant.json` byte-identical to the previous run. This is the actual test for this task — a seed script that duplicates on re-run is broken.

```bash
git diff --stat tests/tenant.json   # expected: no output
```

- [x] **Step 5: Add the npm script and gitignore entry**

In `package.json` scripts:
```json
"seed:jira": "node scripts/jira-seed.mjs"
```
In `.gitignore`, append `.env` if not already present. `tests/tenant.json` **is** committed — it is the contract the e2e suites read.

- [x] **Step 6: Commit**

```bash
git add scripts/jira-seed.mjs package.json .gitignore tests/tenant.json
git commit -m "test: seed the disposable Jira tenant over REST"
```

- [ ] **Step 7: One manual step, recorded not automated**

Setting an issue **cover image** has no public REST endpoint. Do it once by hand in the tenant (open `FNCM-1` → attach any PNG → "Add cover image") and note it in `docs/TESTPLAN.md` (Task 4) as a one-time tenant setup step. Without it the shrink-cover check in Task 2 is skipped, not failed.

---

### Task 2: Shared assertion suite + Chrome headless runner

**Files:**
- Create: `scripts/e2e-checks.mjs`
- Modify: `scripts/pw-real.mjs` (replace its inline checks with the shared suite; keep the login/profile handling at `:57-98` and the Chrome-for-Testing note at `:27-33`)
- Modify: `package.json` (add `e2e:chrome`)

**Interfaces:**
- Consumes: `tests/tenant.json` from Task 1.
- Produces: `runChecks(driver, tenant) -> { passed, failed, results }`, where `driver` is an object with this exact shape, implemented once per browser:
  ```js
  {
    newPage(),                    // -> page handle
    goto(page, url),              // waits for domcontentloaded
    wait(page, ms),
    count(page, selector),        // -> number
    click(page, selector),        // first match
    text(page, selector),         // -> string, '' if absent
    visible(page, selector),      // -> boolean
    evalInExt(fn),                // runs fn in an extension page (storage access)
    consoleErrors(page),          // -> string[] collected since newPage()
    close(page),
    extUrl(file),                 // -> 'chrome-extension://…/popup.html' | 'moz-extension://…/popup.html'
  }
  ```
  Task 3 implements the same interface over Puppeteer/Firefox and calls the same `runChecks`.

**The check list** — each maps to a spec requirement; keep this order, later checks depend on earlier state:

| # | Check | Spec |
|---|---|---|
| 1 | `/browse/FNCM-1`, not activated → 0 `.jfv-field-toggle` | §2 opt-in |
| 2 | popup `#scope-label` contains `FNCM` (company-managed project key detected) | §2, resolver |
| 3 | popup `#activate-button` visible | §6 S-states |
| 4 | after clicking Activate, toggles appear **without reload** | HR-16 |
| 5 | Summary and Status containers have **no** toggle button | §1 protected |
| 6 | clicking a toggle writes `jiraFieldVisibility:v3` with a key not containing `unknown` | §3, issue-type read |
| 7 | after the click, that field's `getComputedStyle(el).display === 'none'` | §4 |
| 8 | reload → field still hidden, count of `[data-jfv-hidden], #jfv-hidden-style` rules stable | persistence |
| 9 | navigate to `/browse/FNCM-2` (Bug) → the Task's hidden field is **visible** | §1 per-issue-type |
| 10 | back to `/browse/FNCM-1` via SPA nav → hidden again, toggles re-render | HR-8 |
| 11 | `/issues?selectedIssue=FNCM-1` → toggles > 0 | HR-12 |
| 12 | bare `/issues` → no `[jfv]` console error | HR-9 |
| 13 | `/browse/FNTM-1` (team-managed, different project) → 0 toggles, and popup `#scope-label` contains `FNTM` | §2 scope, resolver on next-gen |
| 14 | activate `FNTM`, hide a field there → `jiraFieldVisibility:v3` has 2 distinct scope keys | §3 scope isolation |
| 15 | options page lists both `FNCM` and `FNTM` group headings | §4 options |
| 16 | options `.jfv-deactivate-btn` on `FNTM` → FNTM toggles gone, but `jiraFieldVisibility:v3` still holds the FNTM entry | §2 disable preserves prefs |
| 17 | settings: `showFieldButtons=false` → 0 toggle buttons but hidden fields stay hidden | §3 |
| 18 | settings: `shrinkCover=true, coverHeightPx=40` → `#jfv-cover-style` exists and its text contains `40px` (skipped with a printed SKIP if the tenant has no cover image) | shrink-cover |
| 19 | `chrome.storage.sync` holds no `jiraFieldVisibility:v1` / `:v2` key | HR-3 |
| 20 | non-eligible URL (`https://<host>/wiki` or `/jira/settings`) → 0 toggles, no `[jfv]` error | HR-17 |

- [x] **Step 1: Write the shared suite**

Create `scripts/e2e-checks.mjs`. Structure — the whole file is one exported async function plus a tiny `check` recorder; no classes, no framework:

```js
// Browser-agnostic e2e assertions for Field Ninja, run against the seeded test
// tenant. Both launchers (Chrome/playwright, Firefox/puppeteer-BiDi) implement
// the same `driver` shape and call runChecks() — so a Chrome/Firefox behaviour
// divergence shows up as a differing pass list, not as two drifting scripts.
const SETTLE = 6000; // Jira's issue view is slow; the content script polls for 30s

export async function runChecks(d, tenant) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    return ok;
  };
  const skip = (name, why) => {
    results.push({ name, ok: true, skipped: true });
    console.log(`SKIP  ${name}  — ${why}`);
  };

  const ORIGIN = `https://${tenant.host}`;
  const CM = tenant.projects.FNCM, TM = tenant.projects.FNTM;
  const taskKey = CM.sampleIssues.Task, bugKey = CM.sampleIssues.Bug;
  const tmKey = TM.sampleIssues.Task;

  // Every run starts from a clean storage state — a persistent profile would
  // otherwise carry an activation over and silently invert check 1.
  await d.evalInExt(() => chrome.storage.sync.clear());

  const issue = await d.newPage();
  await d.goto(issue, `${ORIGIN}/browse/${taskKey}`);
  await d.wait(issue, SETTLE);
  check('1 not activated -> no toggles', (await d.count(issue, '.jfv-field-toggle')) === 0);

  const popup = await d.newPage();
  await d.goto(popup, d.extUrl('popup.html'));
  await d.wait(popup, 800);
  check('2 project key detected (FNCM)', (await d.text(popup, '#scope-label')).includes('FNCM'));
  check('3 popup offers activation', await d.visible(popup, '#activate-button'));

  await d.click(popup, '#activate-button');
  await d.wait(issue, SETTLE);
  const n = await d.count(issue, '.jfv-field-toggle');
  check('4 activation applies without reload', n > 0, `${n} toggles`);

  // …checks 5–20, each following the same shape…

  return { results, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) };
}
```

Implementation notes the executor needs, so checks 5–20 are not guesswork:

- **check 5 (protected):** evaluate in page — find the container whose heading text is `Summary` / `Status` and assert it holds no `.jfv-field-toggle`. Fall back to asserting no toggle's `aria-label` is `Hide Summary field` or `Hide Status field` (`ui-overlay.ts:59-61,87-92`).
- **check 6/14 (storage):** `d.evalInExt(async () => Object.keys((await chrome.storage.sync.get('jiraFieldVisibility:v3'))['jiraFieldVisibility:v3'] ?? {}))`.
- **check 7 (hidden):** assert on `getComputedStyle(el).display === 'none'` — hidden state is expressed *two* ways (a rule in `#jfv-hidden-style`, or `data-jfv-hidden="true"` + `styles.css:19-21`, see `visibility-engine.ts:128-164`), and computed style is the only assertion that covers both.
- **check 10 (SPA):** navigate by clicking a link inside Jira if one exists, otherwise `history.pushState` + a real in-app link; a full `goto` is not an SPA transition and would not exercise HR-8.
- **check 16 (deactivate):** click `.jfv-deactivate-btn` inside the `.jfv-project-group` whose `.jfv-project-heading` text contains `FNTM` — there are two groups, so an unscoped click hits the wrong one.
- **check 17/18 (settings):** write them directly, `d.evalInExt(() => chrome.storage.sync.set({'jiraFieldVisibility:settings:v1': {showFieldButtons:false, debugOutline:false, shrinkCover:true, coverHeightPx:40}}))`, then wait `SETTLE` — the content script reacts to `storage.onChanged`, no reload needed. Reset to defaults `{true,false,false,80}` afterwards.
- **check 18 skip condition:** if `document.querySelector('div[role="img"][aria-label]:empty')` is null on the issue page, call `skip()` with "tenant has no cover image — see docs/TESTPLAN.md".
- **check 20:** `/jira/settings/…` is eligible by path (`/jira/`) but has no issue; use `${ORIGIN}/wiki` or `${ORIGIN}/people`, which fail the path gate outright.
- Timing: never assert immediately after navigation. The content script debounces rescans by 300 ms and settle-polls up to 100× (`content-entry.ts:33,627-646`). The existing scripts use 1500–8000 ms; keep `SETTLE = 6000` for issue pages and 8000 for the issue navigator.

- [x] **Step 2: Run it before wiring — verify it fails cleanly**

```bash
node -e "import('./scripts/e2e-checks.mjs').then(m => console.log(typeof m.runChecks))"
```
Expected: `function`. (There is no standalone failing test here — the suite needs a driver; the real verification is Step 4.)

- [x] **Step 3: Refactor `scripts/pw-real.mjs` into a driver + launcher**

Keep untouched: the header comment, `CHROME` resolution (`:27-33`), `launch()` (`:61-70`), the session-cookie login flow (`:72-98`), and the `readPopup` background-reload workaround (`:102-109`) — that workaround is required because a popup opened as a tab is itself the active tab, so `tabs.query` returns the popup and the popup renders S0.

Replace: the project-discovery scraping (`:127-156`) — read `tests/tenant.json` instead — and the inline checks (`:160-239`) — call `runChecks` instead.

Add the driver:

```js
import { runChecks } from './e2e-checks.mjs';
const tenant = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/tenant.json'), 'utf8'));
const errorLog = new WeakMap();
const extId = new URL((ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 20000 })).url()).host;

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
  click: (p, sel) => p.locator(sel).first().click(),
  text: (p, sel) => p.locator(sel).first().innerText().catch(() => '').then((t) => t.trim()),
  visible: (p, sel) => p.locator(sel).first().isVisible().catch(() => false),
  consoleErrors: (p) => errorLog.get(p) ?? [],
  close: (p) => p.close(),
  async evalInExt(fn) {
    const x = await ctx.newPage();
    await x.goto(`chrome-extension://${extId}/popup.html`);
    const out = await x.evaluate(fn);
    await x.close();
    return out;
  },
};

const { passed, results, failed } = await runChecks(driver, tenant);
console.log(`\nchrome: ${passed}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
```

Note: the popup checks (2, 3, 4) need `readPopup(popup, popupUrl, issue)` semantics — bring the Jira tab to front, then reload the popup. Expose that as a driver-optional hook `d.refreshPopup?.(popup, jiraPage)` so the Firefox driver can supply its own equivalent; call it in `runChecks` before reading popup state, guarded with `?.`.

- [ ] **Step 4: Run the Chrome suite**

```bash
npm run build
node scripts/pw-real.mjs fieldninjaforjira.atlassian.net
```
Expected: first run may open one window for login (session then persists in `.playwright-jira-profile/`); afterwards fully headless. Expected output: `chrome: 20/20 passed`. Any FAIL must be triaged as a real bug or a real timing problem — never by loosening the assertion.

- [x] **Step 5: Add the npm script**

```json
"e2e:chrome": "node scripts/pw-real.mjs fieldninjaforjira.atlassian.net"
```

- [x] **Step 6: Commit**

```bash
git add scripts/e2e-checks.mjs scripts/pw-real.mjs package.json
git commit -m "test: shared real-tenant e2e suite, Chrome runner"
```

---

### Task 3: Firefox headless runner

**Files:**
- Create: `scripts/e2e-firefox.mjs`
- Modify: `package.json` (bump `puppeteer` to `^24.0.0`, add `e2e:firefox`, `e2e` scripts)

**Interfaces:**
- Consumes: `runChecks` from Task 2, `tests/tenant.json` from Task 1.
- Produces: nothing further; this is a leaf.

**Why Puppeteer and not Playwright:** Playwright ships a Juggler-patched Firefox with no extension-install API; system Firefox will not run under it. Puppeteer ≥23 speaks WebDriver BiDi to a stock Firefox and exposes `browser.installExtension(path)` for unsigned temporary add-ons. The existing Puppeteer integration tests (`tests/integration/*`) use only `launch`, `newPage`, `evaluate`, `$$` — all still present in v24, so the bump is low-risk, but Task 3 Step 2 verifies that explicitly before anything else.

**The `moz-extension://` UUID problem:** unlike Chrome, Firefox's extension origin is a random per-profile UUID, so `d.extUrl('popup.html')` cannot be derived from the gecko id. Pin it by pre-setting the `extensions.webextensions.uuids` pref, which maps gecko id → UUID:

```js
const EXT_ID = 'field-ninja@fieldninja.app';   // manifest.firefox.json
const EXT_UUID = 'f1e1d1a1-1111-4111-8111-111111111111'; // any fixed valid v4
extraPrefsFirefox: {
  'extensions.webextensions.uuids': JSON.stringify({ [EXT_ID]: EXT_UUID }),
  'xpinstall.signatures.required': false,
  'extensions.experiments.enabled': true,
}
```
Then `moz-extension://f1e1d1a1-1111-4111-8111-111111111111/popup.html` is stable.

- [ ] **Step 1: Bump Puppeteer**

```bash
npm install --save-dev puppeteer@^24
npx puppeteer browsers install firefox
```

- [ ] **Step 2: Verify the bump broke nothing — run the existing suites**

```bash
npm run build
npm test
```
Expected: all 7 unit + 10 integration specs still pass. If `tests/integration/setup.ts` breaks on the new API, fix it there (`puppeteer.launch` options at `:42-48`) before continuing — do not proceed with a red suite.

- [ ] **Step 3: Write the Firefox launcher**

```js
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
const EXT_UUID = 'f1e1d1a1-1111-4111-8111-111111111111';
const tenant = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/tenant.json'), 'utf8'));

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

const browser = await puppeteer.launch({
  browser: 'firefox',
  headless: !process.argv.includes('--headed'),
  userDataDir: PROFILE,
  extraPrefsFirefox: {
    'extensions.webextensions.uuids': JSON.stringify({ [EXT_ID]: EXT_UUID }),
    'xpinstall.signatures.required': false,
  },
});
await browser.installExtension(DIST);

const extUrl = (f) => `moz-extension://${EXT_UUID}/${f}`;
const errorLog = new WeakMap();
const driver = {
  extUrl,
  async newPage() {
    const p = await browser.newPage();
    const errs = [];
    p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    errorLog.set(p, errs);
    return p;
  },
  goto: (p, url) => p.goto(url, { waitUntil: 'domcontentloaded' }),
  wait: (p, ms) => new Promise((r) => setTimeout(r, ms)),
  count: (p, sel) => p.$$eval(sel, (els) => els.length).catch(() => 0),
  click: (p, sel) => p.click(sel),
  text: (p, sel) => p.$eval(sel, (e) => e.innerText.trim()).catch(() => ''),
  visible: (p, sel) => p.$eval(sel, (e) => !!e.offsetParent).catch(() => false),
  consoleErrors: (p) => errorLog.get(p) ?? [],
  close: (p) => p.close(),
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
```

- [ ] **Step 4: Log in once, headed**

The Firefox profile starts with no Atlassian session. Run once with `--headed`, log into the tenant manually, close the window; `.firefox-jira-profile/` then carries the session (add it to `.gitignore` — it holds real cookies).

```bash
npm run build:firefox
node scripts/e2e-firefox.mjs --headed
```

- [ ] **Step 5: Run headless**

```bash
node scripts/e2e-firefox.mjs
```
Expected: `firefox: 20/20 passed`, no window opens.

Known divergences to expect and investigate rather than paper over: the MV3 background is a non-module `background.scripts` IIFE on Firefox (`esbuild.config.mjs:22`), and `chrome` is aliased to `browser` at build time (`:44`) — a check that passes on Chrome but fails on Firefox is very likely a real parity bug in one of those two deltas, which is exactly what this runner exists to catch.

If `browser.installExtension` is unavailable or throws on the installed Puppeteer version, stop and report it — do not fall back silently. The documented fallback is `npx web-ext run --source-dir dist-firefox` with the manual checklist from Task 4, which is not headless and must be an explicit user decision.

- [ ] **Step 6: Add npm scripts**

```json
"e2e:firefox": "node scripts/e2e-firefox.mjs",
"e2e": "npm run build && npm run build:firefox && npm run e2e:chrome && npm run e2e:firefox"
```

- [ ] **Step 7: Commit**

```bash
git add scripts/e2e-firefox.mjs package.json package-lock.json .gitignore
git commit -m "test: headless Firefox e2e via puppeteer BiDi"
```

---

### Task 4: Document the test plan and wire it into the docs

**Files:**
- Create: `docs/TESTPLAN.md`
- Modify: `docs/SPEC.md` §10 (test contract — add the real-tenant layer)
- Modify: `CLAUDE.md` (Browser Testing section — record that headless real-tenant e2e now exists)

- [ ] **Step 1: Write `docs/TESTPLAN.md`**

Contents, in this order:

1. **Layers** — table: unit (vitest/happy-dom), integration (puppeteer + static fixtures, `dist/`), real-tenant e2e (Chrome + Firefox, this plan). What each layer can and cannot prove.
2. **One-time setup** — Atlassian API token; `JIRA_EMAIL` / `JIRA_API_TOKEN`; `npm run seed:jira`; the manual cover-image step on `FNCM-1`; the one headed login per browser profile.
3. **Tenant shape** — the two tables from Task 1, plus a pointer to `tests/tenant.json` as the source of truth.
4. **Running it** — `npm test`, `npm run e2e:chrome`, `npm run e2e:firefox`, `npm run e2e`.
5. **The 20 checks** — the table from Task 2 with its spec column.
6. **Known constraints** — verbatim: Chrome ≥137 ignores `--load-extension` on installed Chrome, so Chrome for Testing is used (`scripts/pw-real.mjs:27-33`); Playwright cannot install unsigned Firefox add-ons, hence Puppeteer BiDi; Playwright MCP and `agent-browser` launch without the extension and can only inspect Jira's DOM, so neither can verify extension behaviour.
7. **Manual fallback checklist** — the same 20 checks phrased as human steps, for use when automation is blocked.
8. **Tenant reset** — re-running `npm run seed:jira` after a wipe restores the shape; `tests/tenant.json` must be re-committed if keys changed.

- [ ] **Step 2: Update `docs/SPEC.md` §10**

Add a bullet to the test contract: real-tenant e2e covers activation, per-issue-type isolation, scope isolation, settings, and Chrome/Firefox parity against `fieldninjaforjira.atlassian.net`; see `docs/TESTPLAN.md`.

- [ ] **Step 3: Update `CLAUDE.md` → Browser Testing**

The current text says Claude for Chrome is the only way to observe the built extension. That is now false for the scripted checks. Amend it to: scripted headless verification is `npm run e2e` (Chrome + Firefox, real tenant); Claude for Chrome remains the tool for exploratory/visual checks and anything the 20 checks do not cover. Leave the `agent-browser` warning in place and extend it to Playwright MCP.

- [ ] **Step 4: Verify docs match reality**

```bash
npm run e2e
```
Expected: both runners report `20/20 passed`. Do not commit the docs claiming coverage the run has not demonstrated.

- [ ] **Step 5: Commit**

```bash
git add docs/TESTPLAN.md docs/SPEC.md CLAUDE.md
git commit -m "docs: cross-browser real-tenant test plan"
```

---

## Verification

End-to-end, from a clean checkout:

```bash
npm install
export JIRA_EMAIL=... JIRA_API_TOKEN=...
npm run seed:jira          # idempotent; writes tests/tenant.json
npm test                   # 7 unit + 10 integration specs, offline
npm run e2e                # builds both targets, then Chrome + Firefox real-tenant
```

Success = `npm test` green, `chrome: 20/20 passed`, `firefox: 20/20 passed`, and `git status` clean afterwards (a dirty `tests/tenant.json` means the seed is not idempotent).

Manual, once per tenant lifetime: cover image on `FNCM-1`, and one headed login per browser profile.

## Risks

| Risk | Handling |
|---|---|
| Account lacks Jira admin → cannot create fields/screens | Task 1 Step 2 detects this before any writes; stop and report |
| Team-managed (`FNTM`) project template key rejected by the tenant | Fall back to `gh-simplified-agility-scrum`; if both fail, create `FNTM` by hand and re-run the seed (it will detect and reuse it) |
| `browser.installExtension` missing/broken in Puppeteer 24 | Task 3 Step 5 fails loudly; documented fallback is `web-ext run` + manual checklist, user decides |
| Jira DOM shifts and breaks a selector | Checks assert on the extension's own markers (`.jfv-field-toggle`, `#jfv-hidden-style`, `data-jfv-hidden`), not on Jira's DOM — the only Jira-dependent parts are URLs and the popup's `#scope-label` text |
| Flaky timing on a slow tenant | `SETTLE` is a single constant in `e2e-checks.mjs`; raise it there, never by weakening an assertion |
