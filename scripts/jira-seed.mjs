// Seeds the disposable test tenant into the exact shape the e2e suites expect.
// Idempotent: safe to re-run. Writes tests/tenant.json for the e2e launchers.
//
// Usage:
//   JIRA_EMAIL=... JIRA_API_TOKEN=... node scripts/jira-seed.mjs [--dry-run]
// Token: https://id.atlassian.com/manage-profile/security/api-tokens
// Credentials fall back to the gitignored auth.json ({name, token}) if unset.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOST = process.env.JFV_JIRA_HOST || 'fieldninjaforjira.atlassian.net';
const DRY = process.argv.includes('--dry-run');

let { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
  const authFile = path.join(ROOT, 'auth.json');
  if (fs.existsSync(authFile)) {
    const a = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    JIRA_EMAIL ||= a.name;
    JIRA_API_TOKEN ||= a.token;
  }
}
if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error('set JIRA_EMAIL and JIRA_API_TOKEN (or provide auth.json)');
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
console.log(`authenticated as ${me.emailAddress ?? me.displayName} (${me.accountId})`);

// --- projects ---------------------------------------------------------------
async function ensureProject(key, name, templateKey) {
  const existing = await api('GET', `/rest/api/3/project/search?query=${key}`);
  const hit = existing.values?.find((p) => p.key === key);
  if (hit) {
    console.log(`project ${key} exists`);
    return hit;
  }
  console.log(`creating project ${key}`);
  return api('POST', '/rest/api/3/project', {
    key,
    name,
    projectTypeKey: 'software',
    projectTemplateKey: templateKey,
    leadAccountId: me.accountId,
    assigneeType: 'PROJECT_LEAD',
  });
}

await ensureProject('FNCM', 'Field Ninja CM', 'com.pyxis.greenhopper.jira:gh-simplified-scrum-classic');
await ensureProject('FNTM', 'Field Ninja TM', 'com.pyxis.greenhopper.jira:gh-simplified-agility-kanban');

// --- custom fields (FNCM only; team-managed fields are UI-only) --------------
const FIELD_DEFS = [
  ['FN Text', 'textfield', 'textsearcher'],
  ['FN Paragraph', 'textarea', 'textsearcher'],
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

// FN Select needs options, otherwise it renders as an empty picker with no value.
if (!DRY) {
  const sel = customFields.find((f) => f.name === 'FN Select');
  const numericId = String(sel.id).replace('customfield_', '');
  const ctxs = await api('GET', `/rest/api/3/field/${sel.id}/context`);
  const ctxId = ctxs.values?.[0]?.id;
  if (ctxId) {
    const opts = await api('GET', `/rest/api/3/field/${sel.id}/context/${ctxId}/option`);
    const have = new Set((opts.values ?? []).map((o) => o.value));
    const missing = ['Alpha', 'Beta', 'Gamma'].filter((v) => !have.has(v));
    if (missing.length) {
      console.log(`adding FN Select options: ${missing.join(', ')}`);
      await api('POST', `/rest/api/3/field/${sel.id}/context/${ctxId}/option`, {
        options: missing.map((value) => ({ value, disabled: false })),
      });
    }
  } else {
    console.log(`WARN no context on FN Select (${numericId}) — options skipped`);
  }
}

// Attach to the default screen's first tab, else the fields never render on the
// issue view and every toggle assertion downstream fails for the wrong reason.
if (!DRY) {
  const screens = await api('GET', '/rest/api/3/screens?maxResults=100');
  // The tenant is German; "Default"/"Standard" naming is unreliable. Attach to
  // every screen that FNCM's default scheme could use — extra attachments are
  // harmless, a missing one silently kills 6 checks.
  const targets = (screens.values ?? []).filter((s) => /FNCM|Default|Standard/i.test(s.name));
  if (!targets.length) throw new Error('no candidate screen found — attach fields manually');
  for (const screen of targets) {
    // Team-managed projects expose screens whose tabs are not addressable (400).
    const tabs = await api('GET', `/rest/api/3/screens/${screen.id}/tabs`).catch(() => []);
    const tabId = tabs[0]?.id;
    if (!tabId) {
      console.log(`skip screen ${screen.id} (${screen.name}) — no addressable tab`);
      continue;
    }
    const onTab = await api('GET', `/rest/api/3/screens/${screen.id}/tabs/${tabId}/fields`);
    for (const cf of customFields) {
      if (onTab.some((x) => x.id === cf.id)) continue;
      console.log(`adding ${cf.name} to screen ${screen.id} (${screen.name})`);
      await api('POST', `/rest/api/3/screens/${screen.id}/tabs/${tabId}/fields`, { fieldId: cf.id })
        .catch((e) => console.log(`WARN ${cf.name} -> screen ${screen.id}: ${e.message.slice(0, 120)}`));
    }
  }
}

// --- issues ------------------------------------------------------------------
const WANT = { FNCM: ['Task', 'Bug', 'Story', 'Epic'], FNTM: ['Task', 'Bug'] };
// The tenant renders issue types in its own locale; match on the untranslated
// key where Jira exposes one, else on the localized name.
const ALIAS = {
  Task: ['Task', 'Aufgabe'],
  Bug: ['Bug', 'Fehler'],
  Story: ['Story', 'Storie', 'Geschichte'],
  Epic: ['Epic', 'Epos'],
};
const tenant = { host: HOST, projects: {}, customFields };

for (const [key, types] of Object.entries(WANT)) {
  // On --dry-run the projects were never created, so createmeta 404s. Tolerate it.
  const meta = await api('GET', `/rest/api/3/issue/createmeta/${key}/issuetypes`).catch((e) => {
    if (DRY) {
      console.log(`DRY  createmeta ${key} unavailable (project not created)`);
      return {};
    }
    throw e;
  });
  const available = meta.issueTypes ?? meta.values ?? [];
  const sampleIssues = {};
  for (const t of types) {
    const it = available.find((x) => ALIAS[t].includes(x.name));
    if (!it) {
      console.log(`SKIP ${key}/${t} — issue type not in this project (have: ${available.map((x) => x.name).join(', ')})`);
      continue;
    }
    const summary = `[e2e] ${key} ${t} sample`;
    const found = await api(
      'POST',
      '/rest/api/3/search/jql',
      { jql: `project=${key} AND summary~"\\"${summary}\\"" ORDER BY created ASC`, maxResults: 1, fields: ['key'] }
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
  }).catch((e) => console.log(`WARN could not set custom field values: ${e.message.slice(0, 200)}`));
}

if (DRY) {
  console.log('\nDRY  would write tests/tenant.json');
} else {
  fs.writeFileSync(path.join(ROOT, 'tests/tenant.json'), JSON.stringify(tenant, null, 2) + '\n');
  console.log('\nwrote tests/tenant.json');
}
console.log(JSON.stringify(tenant, null, 2));
