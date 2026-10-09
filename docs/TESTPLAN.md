# Cross-Browser Real-Tenant Test Plan

Reference doc for the real-tenant e2e layer added on `test/cross-browser-e2e`
(plan: `docs/superpowers/plans/2026-08-13-cross-browser-testplan.md`).

**Status (2026-08-14):**

- **Chrome: green.** `npm run e2e:chrome` runs headless and reports
  `chrome: 20/20 passed` (check 18 SKIPs until the cover image of §2 exists).
- **Firefox: runs via geckodriver.** WebDriver-BiDi (the former Puppeteer
  runner) refuses every navigation to `moz-extension://…`, so
  `scripts/e2e-firefox.mjs` now uses classic WebDriver (`selenium-webdriver`).
  Marionette also blocks `moz-extension://` unless Firefox itself starts with
  `-remote-allow-system-access`, which geckodriver rejects as a capability. The
  script therefore spawns Firefox itself and attaches geckodriver with
  `--connect-existing`. Commit 5116fc8 records "20/20 headless"; no pass count
  is recorded in this repo beyond that (not yet re-measured since).
  Known degradation: no BiDi console channel, so checks 12/20 only see errors
  from an injected page hook, not content-script-world errors.

## 1. Layers

| Layer | Tooling | Target | Proves | Cannot prove |
|---|---|---|---|---|
| Unit | Vitest, happy-dom | pure logic (`storage-service`, `jira-context-resolver`) | storage isolation, URL-eligibility matrix, key/scope logic | anything DOM/browser-runtime |
| Integration | Puppeteer, static fixtures | unpacked `dist/` against `tests/fixtures/*.html` | content-script behaviour against a controlled DOM shape | Jira's real, changing markup; Firefox build |
| Real-tenant e2e | Playwright-core (Chrome) / Selenium + geckodriver (Firefox) | unpacked `dist/` + `dist-firefox/` against `fieldninjaforjira.atlassian.net` | end-to-end behaviour on live Jira DOM, Chrome/Firefox build parity | anything not covered by the 20 checks below (§5) |

## 2. One-time setup

- Create an Atlassian API token: https://id.atlassian.com/manage-profile/security/api-tokens
- Set `JIRA_EMAIL` and `JIRA_API_TOKEN` in the environment (or the gitignored `auth.json`).
- Run `npm run seed:jira` — idempotent, provisions/verifies the tenant, writes `tests/tenant.json`.
- Attach a cover image to `FNCM-1` by hand once (no public REST endpoint for this) — open the issue, attach any PNG, "Add cover image". Until this is done, check 18 (shrink-cover) is SKIPped, not failed.
- Firefox prerequisites: system Firefox ≥153 (`C:/Program Files/Mozilla Firefox/firefox.exe`, or set `JFV_FIREFOX`), `npm install` (brings `selenium-webdriver`), network on first run (Selenium Manager downloads geckodriver), Windows PowerShell (XPI packing), `npm run build:firefox` before each run, Marionette port 2828 free.
- One headed login per browser profile, once:
  - Chrome: `npm run e2e:chrome` — first run opens a window for login, session then persists in `.playwright-jira-profile/` (gitignored).
  - Firefox: `node scripts/e2e-firefox.mjs --headed` — session persists in `.firefox-jira-profile/` (gitignored).
  - `scripts/e2e-login.mjs` fills e-mail + password from the gitignored
    `auth.json` automatically. The account enforces **e-mail MFA**, so the
    code itself must be typed by hand in that one headed window; the runner
    waits up to 10 min for it. The `session.token` cookie only appears once
    the tenant host itself has been visited — if the run ends on
    `home.atlassian.com`, just start it again.
- After the one-time login, both runners are fully headless.

## 3. Tenant shape

Source of truth: `tests/tenant.json` (committed). Scripts must read it, never hardcode project keys.

| Project | Key | Style | Issue types | Extra fields |
|---|---|---|---|---|
| Field Ninja CM | `FNCM` | company-managed (`classic`) | Task, Bug, Story, Epic | 6 custom fields, all on the default screen |
| Field Ninja TM | `FNTM` | team-managed (`next-gen`) | Task, Bug | defaults only |

Custom fields on `FNCM` (chosen to cover every branch of `field-id.ts` and every container shape in `field-registry.ts`):

| Name | Type schema |
|---|---|
| FN Text | `com.atlassian.jira.plugin.system.customfieldtypes:textfield` |
| FN Paragraph | `…:textarea` |
| FN Select | `…:select` (options: Alpha, Beta, Gamma) |
| FN User | `…:userpicker` |
| FN Date | `…:datepicker` |
| FN Labels | `…:labels` |

Host: `fieldninjaforjira.atlassian.net`. Tenant renders in German — assertions
must never match localized text (`#scope-label` etc. match on project keys,
selectors, or the extension's own markers, not on Jira's UI strings).

## 4. Running it

```bash
npm test            # 7 unit + 10 integration specs, offline
npm run seed:jira    # idempotent, requires JIRA_EMAIL / JIRA_API_TOKEN
npm run e2e:chrome   # Chrome, real tenant, headless after first login
npm run e2e:firefox  # Firefox, real tenant, headless after first login
npm run e2e          # build + build:firefox, then both runners
```

## 5. The 20 checks

Shared between browsers via `scripts/e2e-checks.mjs`; each browser launcher
(`scripts/pw-real.mjs` for Chrome, `scripts/e2e-firefox.mjs` for Firefox)
implements the same driver interface and calls `runChecks`.

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

## 6. Known constraints

- Chrome ≥137 ignores `--load-extension` on installed Chrome, so Chrome for
  Testing is used instead (`scripts/pw-real.mjs:29-32`).
- Playwright cannot install unsigned Firefox add-ons. WebDriver-BiDi
  (Puppeteer) can, but forbids navigation to `moz-extension://…`
  ("unsupported operation … not allowed in this context"), making popup,
  options page and storage unreachable. The Firefox runner uses
  `selenium-webdriver` + geckodriver (Selenium Manager fetches the driver; first
  run needs network). Firefox is spawned by the script with `-marionette
  -remote-allow-system-access -no-remote -profile .firefox-jira-profile` and
  geckodriver attaches via `--connect-existing` on Marionette port 2828
  (override: `JFV_MARIONETTE_PORT`). Prefs (pinned extension UUID,
  `xpinstall.signatures.required=false`) are written to the profile's `user.js`.
  The extension is installed as a temporary unsigned XPI: `scripts/firefox-xpi.mjs`
  zips `dist-firefox/` to `field-ninja.xpi` (gitignored) with PowerShell
  `Compress-Archive`, so the runner is Windows-only. Run `npm run build:firefox`
  first (the runner aborts if `dist-firefox/manifest.json` or its `gecko.id`
  is missing).
- Playwright MCP and `agent-browser` both launch a browser without
  `--load-extension` — they can only inspect Jira's DOM, never the
  extension's own toggles/state. Neither can verify extension behaviour.
- `npx puppeteer browsers install firefox` does not produce a usable binary
  on Windows (only `.metadata.json` lands in the cache). The Firefox runner
  instead uses the system install at `C:/Program Files/Mozilla Firefox/firefox.exe`,
  overridable via `JFV_FIREFOX`. It must satisfy `manifest.firefox.json`'s
  `strict_min_version` (153.0).

## 7. Manual fallback checklist

Use when automation is blocked (e.g. `browser.installExtension` broken, or
before the one-time login has happened). Same 20 checks, phrased as human
steps against the real tenant with `dist/` (Chrome) or `dist-firefox/`
(Firefox, via `about:debugging` → Load Temporary Add-on) loaded:

1. Open `/browse/FNCM-1` without activating — confirm no toggle icons appear next to any field.
2. Open the extension popup — confirm the scope label shows `FNCM`.
3. Confirm the popup shows an "Activate" control.
4. Click Activate — confirm toggle icons appear on the issue page without reloading it.
5. Confirm Summary and Status have no toggle icon.
6. Click a toggle to hide a field — inspect `chrome.storage.sync` (e.g. via the options page or devtools) for a new pref key that does not contain `unknown`.
7. Confirm the hidden field is actually invisible on the page.
8. Reload the page — confirm the field is still hidden.
9. Open `/browse/FNCM-2` (a Bug) — confirm the field hidden on the Task is visible here.
10. Navigate back to `/browse/FNCM-1` via an in-app link (not a full reload) — confirm the field is hidden again and toggles re-render.
11. Open `/issues?selectedIssue=FNCM-1` — confirm toggles appear.
12. Open bare `/issues` — confirm no `[jfv]` errors in devtools console.
13. Open `/browse/FNTM-1` — confirm 0 toggles and popup scope label shows `FNTM`.
14. Activate `FNTM` and hide a field there — confirm storage now has two distinct scope keys (one per project).
15. Open the options page — confirm both `FNCM` and `FNTM` group headings are listed.
16. Click deactivate on the `FNTM` group in options — confirm FNTM toggles disappear from the issue page, but the FNTM pref entry remains in storage.
17. In options/settings, turn off "show field buttons" — confirm 0 toggle icons but previously-hidden fields stay hidden.
18. Turn on shrink-cover with a height of 40px (requires the cover image from §2) — confirm the cover area is styled to ~40px tall.
19. Inspect storage — confirm no legacy `jiraFieldVisibility:v1` or `:v2` key exists.
20. Open a non-eligible URL such as `/wiki` or `/jira/settings` on the tenant host — confirm 0 toggles and no `[jfv]` console error.

## 8. Tenant reset

Re-running `npm run seed:jira` after a tenant wipe restores the same shape
(projects, fields, sample issues) idempotently. If any issue keys or field
IDs change, re-commit the regenerated `tests/tenant.json` — it is the
contract both e2e launchers read, and a stale copy will point checks at
issues that no longer exist.
