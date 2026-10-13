# Changelog

Format: gruppiert nach Feature/Milestone, nicht nach Einzel-Commit. Commit-Hashes in Klammern zur Nachvollziehbarkeit.

## [Unreleased]

## [0.4.4] — 2026-10-13

`manifest.json`/`package.json` raised to `0.4.4` (0.4.1–0.4.3 were local test builds only). Contains everything merged since 0.4.0, including storage v4.

- feat(controls): issue-header controls hideable per issue type — Agents (`ctl:ai-agents`), Improve Story (`ctl:improve-issue`), Open in coding tool (`ctl:icon:<path hash>`, no stable testid, matched as the status-row child with exactly one button), floating Rovo button (`ctl:rovo`); fixed English labels. Status + these controls use an 18px corner badge outside the button instead of the overlay toggle (no more mis-clicks on the status dropdown); status-row siblings put it bottom-right because Jira's tooltip covers the top corner. Our own badge buttons are excluded from matching (fixed a hide/unhide flicker loop).
- feat(popup): dark theme by default with a "Dark mode" switch (`Settings.popupTheme`, default `dark`).
- chore(firefox): `browser_specific_settings.gecko.data_collection_permissions: { required: ["none"] }` — required by AMO for new add-ons; `web-ext lint` 0 errors / 0 warnings.

- feat(panels): Forge/Connect app sections in the issue sidebar (e.g. OKR, Backbone) are hideable per issue type; id `app:<appId>/<moduleKey>` from the extension ARI (env id dropped), label from the section title; app containers excluded from section auto-hide. Also lists the native automation audit-log panel.
- chore(deps): npm audit 19 → 0 vulnerabilities (3 critical, all dev tooling — the shipped extension bundles no npm packages). Removed a stray `dependencies` block (transitive packages pinned at vulnerable versions, never imported); bumped esbuild 0.28, happy-dom 21, puppeteer 25, vitest 5 (+ vite 8). Vitest config moved to `test.projects` (unit=happy-dom, integration=node) with `clearMocks: false`. Requires Node >=22.12 (`engines`); puppeteer 25 postinstall is blocked by npm allowScripts — run `npx puppeteer browsers install chrome` once after a fresh install.
- refactor(selectors): Jira DOM selectors centralized in `src/lib/jira-selectors.ts`, no behaviour change (b845424).
- feat(popup): popup waits for activation ACK (`GET_FIELDS.isActive`, 25ms poll, 200ms cap) instead of a fixed 200ms sleep; former empty catches now log `[jfv]` `console.warn` (6164e3d).
- feat(options): search box filters saved prefs by project (6a3328a).
- test: unit tests for service worker + toggle overlay; vitest 20 files / 148 tests (861407d).
- test(firefox): `hasSession()` ignores expired session cookies; Firefox e2e 20/20 (check 18 skipped, tenant has no cover) (3301185).
- chore: spike script removed (12afdf3); stale `PLAN.md` removed (89984b8).

### Storage v4

- feat(storage): prefs sharded into one `chrome.storage.sync` item per site+project (`jiraFieldVisibility:v4:<host>:<PROJ>` → `{ <issueTypeId>: fieldIds[] }`); the 8 KB item limit now applies per project, not to all prefs together (e9353e7, b68e1f2).
- feat(storage): one-time `migrateV3ToV4()` in the service worker on install/update/startup, before reinjection (order: migrate → prune → legacy drop on install → reinject; a migration error is logged and the rest continues): fill-missing merge (v4 wins), one `set`, v3 removed only afterwards; idempotent (d639913, a0e30ac).
- feat(storage): `pruneLocalCaches()` drops label/tab/section caches of scopes with neither prefs nor activation; no-op while v3 exists (d639913, a0e30ac).
- feat(popup,options): sync usage line ("Sync storage: X of 100 KB", warning at ≥80 %) and inline quota errors via `StorageQuotaError`/`quotaMessage()`; the popup `alert()` is gone (b68e1f2, 9d54767, 3b29421).
- feat(options): Export / Import. Download via Blob + `<a download>` (no new permission); import validated by the pure `validateExport()` (any violation rejects the whole file), merge with the file winning per issue type; `buildExport` rounds and clamps `coverHeightPx` (as does the popup), export failures show an inline error (d4b2345, 6738e08, 3b29421).
- feat(options): "Copy to…" per pref row, union-copies hidden fields into other known issue types; one panel per row (double-click guard), Copy disabled while writing, "Select at least one target." / "Could not load copy targets." (6738e08, 55cfff7).
- test: e2e checks 6/14/16/19 and the options-grouping seed read v4 shards; check 19 also rejects `:v3` (857ca3a).
- docs(spec): HR-3 rewritten (no v1/v2 migration, exactly one v3→v4 migration), HR-4/HR-5/HR-16 updated, new HR-21 (import is a trust boundary). Reason: per-project shards need one read of v3; under the old HR-3 every user would lose all prefs on update (59158b8).

## [0.4.0] — 2026-08-13

`manifest.json`/`package.json` auf `0.4.0` angehoben. Minor, weil ein neues Build-Target dazukommt; bestehendes Chrome-Verhalten ist unverändert.

### Firefox-Port (zweites Build-Target)

`npm run build:firefox` baut aus demselben `src/` nach `dist-firefox/`; `npm run build:all` baut beide Targets. `npm run build`/`dev` bleiben unverändertes Chrome.

- Firefox hat keinen MV3-Service-Worker (Gecko) — Background läuft dort als IIFE über `background.scripts` statt `service_worker`/ESM (`esbuild.config.mjs:20-23,69`).
- `chrome`-Namespace wird im Firefox-Build per esbuild `define: { chrome: 'browser' }` ersetzt, kein `webextension-polyfill` nötig (`esbuild.config.mjs:44`).
- `manifest.firefox.json` trägt nur die Deltas (u. a. Pflichtfeld `browser_specific_settings.gecko.id`) und wird zur Build-Zeit flach über `manifest.json` gemerged (`esbuild.config.mjs:65-73`).
- Das graue Toolbar-Icon (nicht-eligible Tab) ist jetzt für **beide** Targets eine statische PNG (`icons/icon{16,48}-grey.png`, `scripts/make-grey-icons.cjs`) statt zur Laufzeit per `OffscreenCanvas` erzeugt zu werden — der alte Pfad war worker-only und in Firefox nicht verfügbar.
- Verifiziert: Typecheck, Build, 115 Unit- + 11 Integrationstests sowie `build:firefox` grün; manuell in Firefox (`about:debugging`, `dist-firefox/`, inkl. lokalisierter Jira-UI) und erneut in Chrome geprüft. AMO-Submission ist bewusst nicht Teil dieser Änderung.

## [0.3.0] — 2026-08-13

`manifest.json`/`package.json` auf `0.3.0` angehoben. Minor, weil ein neues Feature dazukommt; bestehende Prefs bleiben unverändert gültig.

### Shrink work item cover

Jira Cloud reserviert für das Work-Item-Cover viel vertikalen Platz oberhalb der Felder. Neue globale Einstellung im Popup (`[x] Shrink work item cover to [80] px`), gespeichert im bestehenden `Settings`-Objekt (`jiraFieldVisibility:settings:v1`) — bewusst global, nicht pro Host/Projekt.

- `syncCoverStyle(px | null)` schreibt ein eigenes `<style id="jfv-cover-style">` in den `<head>`; damit greift der `markOwnMutation`-Vertrag des DOM-Observers nicht (235326a).
- `applyCoverStyle()` in `content-entry.ts` ist ein zweiter `isActive`-Choke-Point neben `render()` — nötig, weil die Settings-/Activation-Callbacks `render()` nur bei `onIssuePage` erreichen. Dokumentiert als Abweichung zu HR-1 (2508e9f, da5ac7c, 38b9e19).
- Der Wert wird debounced auf `input` gespeichert, damit er das Schließen des Popups überlebt; zurückgeschrieben (geklemmt) wird das Feld nur auf `change` (7fcdde4, 6ca65c4).
- Die Regel trifft das Cover **und dessen direktes Elternelement**, damit der reservierte Platz mitschrumpft und das Summary nach oben rutscht. Ein zusätzlicher Großeltern-Selektor kollabierte den gemeinsamen Header-Container und wurde per Playwright-Fixture-Messung wieder entfernt (4e48772, 5d375b8).
- Der Cover-Selektor matcht **strukturell statt über den Label-Text**: `div[role="img"][aria-label]:empty` (b23dac3). Der vorherige Suffix-Match `[aria-label$="cover" i]` traf auf einer deutschen Jira-Oberfläche nichts — dort heißt das Label `Vorgangstitelbild`, das Feature war damit auf allen nicht-englischen Instanzen wirkungslos. Eine Locale-Liste scheidet aus (Jira liefert ~25 Sprachen). Messung an einer echten deutschen Issue-Seite: das Cover ist das einzige `div[role="img"]` **mit** `aria-label` und ohne Kindknoten; alle übrigen 15 (Assignee-Avatare) haben kein `aria-label` und je 2 Kinder. Ein stabiles `data-testid` gibt es weder am Cover noch an den beiden ersten Vorfahren — das nächstgelegene ist `issue.views.issue-details.issue-layout.issue-layout`, also genau der Container aus 4e48772, der nicht angefasst werden darf.

### Fix: Race zwischen `storage.onChanged` und dem Write-Seq-Gate

Ein sporadisch fehlschlagender Integrationstest ("Rapid toggling", ~4/26 Läufe) war kein Testfehler, sondern eine echte Race Condition.

- `onPrefsChanged` vertraute dem Payload des `chrome.storage.onChanged`-Events. Das Event kann gegenüber dem `issued === committed`-Gate out of order eintreffen, wodurch ein veralteter Stand `currentHiddenFieldIds` per Full-Remount überschrieb. Jetzt wird per `loadHiddenFieldIdsAndRender()` frisch aus dem Storage gelesen (9e18c88).
- Der Gate-Check ist synchron, das Nachladen async — ein Klick im Fenster dazwischen konnte den Button-Closure auf einen alten Stand zurücksetzen. `renderGen`-Generation-Guard in `loadHiddenFieldIdsAndRender()` verwirft veraltete Läufe vor jeder Zuweisung; serialisiert alle fünf Call-Sites (e4692f4).
- Die Testdatei blieb unverändert (kein hochgesetzter Timeout). 20/20 Schleifenläufe grün, Suite 126/0.

## [0.2.0] — 2026-08-03

`manifest.json`/`package.json` auf `0.2.0` angehoben (Wave D2 in `docs/PLAN.md`). Minor statt Patch, weil die verworfenen v1/v2-Prefs (siehe unten) jeden Nutzer beim Update zur Neukonfiguration zwingen.

### Site-scoped activation (Storage v3, Opt-in pro Site × Projekt)

Zweistufiges Aktivierungsmodell: eine Seite ist *eligible* (URL-Gate) oder *aktiviert* (expliziter User-Opt-in pro `host:projectKey`). Nur aktivierte Scopes verändern die Jira-Seite.

- Storage-Schema auf v3 gehoben: Keys tragen jetzt `host:projectKey:issueTypeId`, dazu ein eigener Activations-Key `jiraFieldVisibility:activations:v1` (`ebd59af`).
- Alle Seiteneffekte (DOM-Schreiben, Toggles, Observer) hinter das Aktivierungs-Gate gezogen (`6bc2155`).
- Popup zur Sechs-State-Machine (S0–S5) ausgebaut, inkl. Aktivieren/Deaktivieren-Buttons pro Scope (`e0d14e7`).
- Integrationssuite läuft durch das echte Aktivierungs-Gate statt es zu umgehen (`68707d7`).
- Toolbar-Icon wird auf nicht-eligible Tabs grau eingefärbt, Graustufe zur Laufzeit via OffscreenCanvas erzeugt (`9377baf`).
- Options-Seite gruppiert Prefs nach Site und Projekt statt einer flachen Liste (`d801ca5`).
- Jira-Issue-Navigator-URLs (`/issues?...&selectedIssue=...`) sind jetzt eligible — Match-Pattern ergänzt in Manifest, Service-Worker-`tabs.query` und Resolver (`1736620`).
- Detailansicht des Issue-Navigators auf den `issue-layout`-Container gescoped, um Board-Card-Leaks zu vermeiden (`55c332c`).
- Popup bekommt einen Settings-Block für globale Optionen (`1ab3c4f`).
- Debug-Mode, Bulk-Hide/Show sowie eine dritte, von den Prefs getrennte Write-Chain für Settings (`a7fbe5e`).
- Wildcard-Projekt-Tier und totes `applyVisibility` entfernt (`09fe599`).
- Playwright-Verifikationsharness ergänzt, inkl. Lauf gegen echten Tenant mit Storage-Reset zu Beginn jedes Laufs (`7b72b7c`, `6d8d399`, `13a6234`).
- **Keine Migration von v1/v2**: Legacy-Prefs werden beim Install gedroppt (`dropLegacyPrefs()`), nie gelesen oder gemerged — bewusste Entscheidung, siehe `docs/SPEC.md#3-storage-schema-v3`.
- **Bugfix `field-registry`**: Felder wurden still verschluckt. `LABEL_SELECTOR` (`'label, [data-testid*="label"]'`) matchte per Substring, der Container-Fallback in `findContainer()` suchte unbegrenzt in Nachfahren — zwei Geschwisterfelder unter einem gemeinsamen Wrapper ohne `CONTAINER_MARKER_SELECTOR`-Treffer (z. B. `role="dialog"`) teilten sich denselben Container, die Dedup in `listFields()` warf eins davon weg. Gefixt über einen Ownership-Walk in `isGenuineLabelMatch()`.

### Shrink-Cover-Feature (opt-in Cover-Bild-Höhenlimit)

Popup-Setting `shrinkCover` + `coverHeightPx` (20–600px, Default 300) schreibt eine Höhenbeschränkung fürs Jira-Cover-Bild in ein eigenes `<style id="jfv-cover-style">`-Element in `<head>`. Liegt außerhalb `document.body` und damit außerhalb des `markOwnMutation`-Vertrags von `dom-observer.ts` — kein Observer-Rückkopplungsrisiko.

- `syncCoverStyle()` in `visibility-engine.ts` clamped serverseitig auf 20–600px als Validierungsstelle der Engine (der Popup-Input klemmt zusätzlich vor dem Speichern); der Popup-Zahleneingabe-Wert kann dadurch nie einen Wert persistieren, der nicht dem gerenderten entspricht.
- `applyCoverStyle()` (`content-entry.ts:77-79`) ist ein bewusster zweiter `isActive`-Choke-Point neben `render()` — dokumentiert als Abweichung von HR-1 in `docs/SPEC.md`, weil Settings-/Aktivierungs-Callbacks `render()` nur bei `onIssuePage` erreichen, die Cover-Regel aber auch außerhalb einer offenen Issue gated werden muss.
- Final-Review-Fixes: `aria-label`-Selektor von Substring- auf Suffix-Match verengt (verhinderte Kollisionen mit „Discover"/„Recovery"/„coverage"), Popup-Zahleneingabe committet jetzt zusätzlich debounced auf `input` (verhindert Datenverlust beim Schließen des Popups vor `change`), doppelte Gate-Logik in `render()` durch `applyCoverStyle()`-Aufruf ersetzt, fehlender `applyCoverStyle()`-Call nach `recomputeActive()` im SPA-Watcher ergänzt, `aria-label` auf dem Zahlenfeld für Screenreader ergänzt.

### Board-view fixes & per-project prefs (Vorstufe, bereits vor site-scoped activation auf diesem Branch)

- Field-Toggle-UI leakte auf die Jira-Board-Ansicht hinein; Scan-Root auf das Issue-Panel eingeschränkt (`172da65`).
- Board-Panel setzt sein `data-testid` erst spät — Toggles wurden dadurch teils gar nicht gemountet, gefixt über den Settle-Poll (`279cfa1`).
- Field-Visibility-Prefs werden ab hier per Projekt-Schlüssel getrennt statt global pro Issue-Type (`d78aed4`).
- Browser-Testing-Doku auf Claude for Chrome umgestellt, da `agent-browser` die Extension-Runtime nicht sieht (`e2361bb`).
- Field-Toggles mounten jetzt zuverlässig bei SPA-Navigation innerhalb des Boards (`07d9e0f`).
- Hidden-Fields-Verwaltung pro Issue-Type in die Options-Seite verlegt (`9cd2127`).

---

Diff-Basis: `git log d507883..HEAD` (Merge-Base zu `main`, umfasst die beiden oben genannten Features).
