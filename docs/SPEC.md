# SPEC.md — Field Ninja for Jira

> Normativer Contract, kein Prosa-Produkttext. Jede Aussage trägt einen `file:line`-Beleg.
> Reviewer ohne Branch-Kontext muss jede Regel gegen den Code prüfen können — falsifizierbar, nicht beschreibend.

## 0. Über dieses Dokument
- SPEC ist **normativ**: Code ≠ SPEC ⇒ entweder Bug oder SPEC-Änderung, nie stillschweigend.
- Zielgruppe: `@reviewer` (Spec-Audit) und `@qa-verifier` (Akzeptanz) — beide ohne Branch-Kontext.
- Historie → `docs/CHANGELOG.md`, offene Arbeit → `docs/PLAN.md`.
- Stand: Storage v3 / site-scoped activation.

## 1. Produkt & Scope
- Field Ninja for Jira (Repo `jira-field-visibility`): MV3-Extension, blendet Jira-Cloud-Issue-Felder **pro Site × Projekt × Issue-Type** aus (`README.md:1-13`).
- Kein Jira-Admin-Recht nötig, rein clientseitige DOM-Manipulation (`README.md:13`, `PRIVACY.md:21-23`).
- **Nicht-Ziele (normativ):** kein Backend, kein Server, kein Account, keine Analytics/Telemetry, keine Third-Party-Scripts, kein Remote-Code (`PRIVACY.md:5,16-23`).
- Permissions-Budget ist Teil der Spec — jede Erweiterung ist ein Spec-Change: `storage`, `activeTab`, `scripting`, Host nur `https://*.atlassian.net/*` (`manifest.json:6-7`).
- Geschützte Felder (Summary/Status) sind nicht versteckbar. Der `protected`-Flag wird in `FieldMeta` deklariert (`src/types/field-meta.ts:11-18`), von `field-registry.ts` gesetzt — Match über `PROTECTED_LABELS` ("summary"/"status", normalisiert) oder über `PROTECTED_TESTID_SUBSTRINGS` (`issue-field-summary`, `issue-field-status`, `ref-spotlight-target-status-spotlight`) (`field-registry.ts:136,150,415-419`) — und an drei Stellen enforced: `visibility-engine.ts:64,95,155,185` (Anwendung) und `ui-overlay.ts:81` (kein Toggle-Button für protected Felder).

## 2. Aktivierungsmodell (Opt-in)
- **Zwei Stufen**: (a) *eligible* = URL-Gate, (b) *activated* = expliziter User-Opt-in pro `host:projectKey`. Nur (b) erlaubt Seitenveränderung.
- URL-Gate `isEligibleUrl()`: `hostname.endsWith('.atlassian.net')` **UND** Pfad startet mit `/browse/`, `/jira/` **oder** ist exakt `/issues` bzw. `/issues/...`; `undefined`/Müll → `false` (`jira-context-resolver.ts:36-49`).
  - `endsWith` (kein Regex-Anchor) ist Absicht: fängt Suffix-Spoof `evilatlassian.net` (`:30-35`).
  - Das Gate ist **absichtlich strenger** als das Manifest-Match-Pattern und die `tabs.query`-Liste. Es ist die eine Stelle, die entscheidet; der Content-Script ist ohne Aktivierung inert.
  - Single Source: SW + Popup importieren dieselbe Funktion (`service-worker.ts:7`, `popup.ts:10`).
- **`hostname`, nicht `host`**: Port würde einen zweiten Doppelpunkt in den doppelpunktgetrennten Key bringen (`localhost:4173`); `hostname` = `localhost`. Entspricht auch dem User-Begriff „Site" (`prefs.ts:2`).
- Scope = `host + projectKey`; ProjectKey kommt aus Issue-Key (`ABC-1` → `ABC`) oder, ohne Issue-Key, aus `/jira/<produkt>/projects/(ABC)` (`jira-context-resolver.ts:51,213-233`).
- Aktivieren/Deaktivieren nur über Popup (`popup.ts:79-87`) bzw. Options-Seite (`options.ts:237-240`). Deaktivieren **löscht keine Prefs**.
- Wirkung ohne Reload: Popup schreibt Storage → `onActivationsChanged` im Content-Script (`content-entry.ts:545-553`).

## 3. Storage-Schema v3
- Alles in `chrome.storage.sync`, außer opportunistischen Caches in `chrome.storage.local`.
- Keys (`prefs.ts:40-44`):
  - `jiraFieldVisibility:v3` → `Record<'${host}:${projectKey}:${issueTypeId}', Pref>` (`prefs.ts:10,21-23`)
  - `jiraFieldVisibility:activations:v1` → `Record<'${host}:${projectKey}', true>` (`prefs.ts:13,16-18`)
  - `jiraFieldVisibility:settings:v1` → `Settings { showFieldButtons, debugOutline, shrinkCover, coverHeightPx }`, global, **nicht** scope-behaftet (`prefs.ts:46-53`)
  - `LEGACY_PREFS_KEYS = ['…:v1','…:v2']` → nur zum Löschen (`prefs.ts:44`)
- `Pref = { host, projectKey, issueTypeId, hiddenFieldIds[] }` (`prefs.ts:1-7`).
- Local-Caches (best effort, nie autoritativ, v2-Präfix): `jfv-field-labels:v2:`, `jfv-tab-fields:v2:`, `jfv-section-fields:v2:` (`prefs.ts:26-38`).
- Warum **separater** Activations-Key statt Sentinel im Prefs-Store: Deaktivieren muss Prefs erhalten, eigenes `onChanged`-Signal, `Object.values(prefs)` in Options bleibt sauber; `Record<string,true>` = idempotentes Setzen ohne Dedupe (`storage-service.ts:359-374`).
- Quota: ein einzelnes 8-KB-Item; `savePrefs` wirft laut statt still zu droppen; Escape-Hatch = Split auf per-Projekt-Keys (`storage-service.ts:26-30,38-50`).
- **Keine Migration von v1/v2** — bewusst verworfen; `dropLegacyPrefs()` löscht sync-Legacy + verwaiste `:v1:`-Local-Caches, One-Shot bei `onInstalled` (`storage-service.ts:391-411`, `service-worker.ts:90-94`).

## 4. Modulverantwortlichkeiten

| Datei | Verantwortung | darf NICHT |
|---|---|---|
| `src/types/prefs.ts` | Key-Bau + Storage-Konstanten; einzige Stelle, die Key-Format kennt (`:16-44`) | Key-Format an anderer Stelle duplizieren |
| `src/types/messages.ts` | `GET_FIELDS`-Message + `GetFieldsResponse {onIssuePage, issueTypeId, projectKey, host, fields}`; `PopupFieldInfo {id, label, hidden}` als DOM-freies Popup-Format; einziger Message-Typ des Projekts (`ExtensionMessage = GetFieldsMessage`) (`messages.ts:1-25`) | einen zweiten Message-Typ einführen |
| `src/lib/jira-context-resolver.ts` | Kontext (`host/projectKey/issueKey/issueTypeId`), Scan-Root, SPA-Watcher, `isEligibleUrl`; wirft nie (`:21-49,176-343`) | werfen; `document` statt Scan-Root lesen |
| `src/lib/storage-service.ts` | **einziges** Gateway zu `chrome.storage`; Serialisierung + Write-Seq-Metadaten (`:14-31`) | von woanders direkt auf `chrome.storage.sync` zugreifen |
| `src/lib/field-registry.ts` | DOM→`FieldMeta[]` via `listFields`/`listPanels`/`listTabs`/`listSections`/`listUndetectedCandidates`, plus `findContainer` (Container-Auflösung); setzt den `protected`-Flag (`:177-597`) | Protected-Felder unmarkiert lassen |
| `src/lib/field-id.ts` | stabile Feld-ID über Re-Renders: `normalizeLabel`, `hashString`, `deriveFieldId(node, label, opts?)` (`:7-63`) | ID von DOM-Reihenfolge abhängig machen |
| `src/lib/visibility-engine.ts` | reine Berechnung (`computeVisibilityDiff`, `computeHiddenTabs`, `computeHiddenSelectors`, `computeHiddenSections`) + DOM-Schreiben (`writeHiddenAttr`, `syncHiddenStylesheet`, `syncCoverStyle`, `toggleField`) (`:31-240`) | protected Felder ausblenden |
| `src/lib/ui-overlay.ts` | `mountFieldToggle(host, field, projectKey, issueTypeId, hidden, onCommit)`, gibt Cleanup-Funktion zurück; verweigert Mount für `field.protected` (`:71-81`) | Toggle für protected Felder mounten |
| `src/lib/dom-observer.ts` | **eine** geteilte MutationObserver-Instanz + `markOwnMutation` Self-Write-Suppression (`content-entry.ts:28,577`) | eine zweite Observer-Instanz aufmachen |
| `src/content/content-entry.ts` | Orchestrierung + Aktivierungs-Gate; einzige Datei, die die Jira-Seite verändert | DOM-Schreiben außerhalb `render()`/Teardown |
| `src/background/service-worker.ts` | Re-Injection, Toolbar-Icon-Zustand, Legacy-Cleanup (`:51-123`) | neue Permission ohne Manifest-Änderung annehmen |
| `src/popup/popup.ts` | Sechs-State-Machine, Feldliste, Aktivierungs-Buttons, globale Settings | Aktivierungszustand aus der Content-Antwort statt aus Storage lesen |
| `src/options/options.ts` | Verwaltung aller Scopes (Gruppierung, Reset, Deaktivieren) | Prefs bei Deaktivieren löschen |

Anmerkung: `applyVisibility` existiert nicht mehr (entfernt in `09fe599`, s. `docs/CHANGELOG.md`) — Anwendung läuft heute über `toggleField`/`syncHiddenStylesheet`/`writeHiddenAttr`. `mountGlobalPanel` existiert nicht als Export; die einzige Fundstelle ist ein veralteter Doc-Kommentar in `content-entry.ts:153`, der Funktionsname ist nicht (mehr) implementiert.

## 5. Kontroll-/Datenfluss
- Popup → `setActivated` → `storage.sync` → `onActivationsChanged` → Content-Script → `render()`. **Kein** neuer Message-Typ (`popup.ts:81`, `content-entry.ts:545`).
- Popup fragt Aktivierungszustand **selbst aus Storage** (`isActivated`), nicht aus der Content-Antwort → kein Round-Trip-Race (`popup.ts:180`).
- Feld-Toggle → `toggleField` → `onPrefsChanged` (mit Seq-Gate) → `render()` (`content-entry.ts:656-709`).
- SW setzt Icon aus `tab.url` in `onActivated`/`onUpdated` (+ `changeInfo.url` für SPA-Wegnavigation) (`service-worker.ts:101-123`).
- Content-Script wird auf **allen** eligible Seiten injiziert, auch nicht-aktivierten — es liefert dem Popup den ProjectKey und wendet Aktivierung sofort an; Injection ≠ Modifikation.

## 6. Popup-States S0–S5

| S | Bedingung | UI |
|---|-----------|-----|
| S0 | `!isEligibleUrl(tab?.url)` (`popup.ts:152`) | „Not available on this page."; Feldliste/Buttonreihe/Scope-Bar/Reset/**Settings** aus (`:104-105,108-111`) |
| S1 | eligible, aber `tab.id === undefined` **oder** `sendMessage` wirft (`:157,164-171`) | „Reload the page to enable Field Ninja."; Settings sichtbar, Reset aus |
| S2 | Antwort da, `projectKey === null` (`:175`) | „No project detected — open an issue or a project board."; kein Aktivieren-Button |
| S3 | ProjectKey da, `!isActivated` (`:180-183`) | Scope-Zeile `host · PROJ` + Primärbutton „Enable here"; keine Feldliste (`:122-131`) |
| S4 | aktiviert, `!onIssuePage` (`:186`) | Scope „Active on PROJ" + „Disable here"; Feldliste zeigt Leertext „Open an issue to manage its fields."; Hide/Show all disabled (`:37-39,47-54,132-146`) |
| S5 | aktiviert, `onIssuePage` | Volle Feldliste + Scope-Zeile + „Disable here" |

- Reset-All sichtbar in S2–S5, versteckt in S0/S1 (`:104`). Settings-Checkboxen nur in S0 versteckt (`:105`).
- Nach Aktivieren: 200 ms Warten vor Re-Query, dokumentierte Race gegen `onActivationsChanged` (`:83-85`).

## 7. Hard Rules (Review-Checkliste)

- **HR-1 Ein Gate, ein Choke-Point.** Jeder Seiteneffekt liegt hinter `if (!isActive) { teardownPageEffects(); return; }` am Anfang von `render()`. *Verletzt, wenn:* ein neuer Code-Pfad DOM schreibt/Toggles mountet außerhalb `render()`. (`content-entry.ts:184-189`)
  - **Abweichung (erlaubte Ausnahme):** `applyCoverStyle()` (`content-entry.ts:77-79`) ist ein zweiter, bewusster `isActive`-Choke-Point für die `<head>`-Cover-Regel. Nötig, weil Settings-/Aktivierungs-Callbacks `render()` nur bei `onIssuePage` erreichen — die Cover-Regel muss aber auch außerhalb einer Issue-Seite (de)aktiviert werden. Erlaubt, weil sie dasselbe `isActive`-Gate durchsetzt wie `render()` und die einzige zusätzliche Stelle bleibt.
- **HR-2 Teardown bleibt idempotent & vollständig.** Neue Seiteneffekt-Arten müssen in `teardownPageEffects()` zurückgebaut werden (Stylesheet, `data-jfv-hidden`, ToggleMap, Tab-/Section-Sets). (`:78-91`)
- **HR-3 Keine Migration alter Prefs.** v1/v2 werden gelöscht, nie gelesen/gemerged. *Verletzt bei:* jedem Lesezugriff auf `LEGACY_PREFS_KEYS`. (`storage-service.ts:33-36,402-411`)
- **HR-4 Zwei getrennte Write-Chains + eine Seq-Queue.** `enqueueWrite`/`issuedWriteSeq`/`committedWriteSeq` gelten **nur** für Prefs-Writes; `saveSettings` nutzt `settingsWriteChain`, `setActivated` nutzt `activationsWriteChain`. *Verletzt, wenn:* Settings/Activations in `enqueueWrite` gehängt werden (ein laufender Feld-Toggle würde das Aktivierungs-Re-Render schlucken). (`storage-service.ts:115-122,293-305,352-374`)
- **HR-5 storage-service ist das einzige Gateway.** Kein `chrome.storage.sync.*` außerhalb. Einzig erlaubte Direktzugriffe: die `storage.local`-Caches in `content-entry.ts` (`:252,266,312`) — explizit best-effort. (`storage-service.ts:14-24`)
- **HR-6 Schreib-Guard.** Kein Write ohne `host && projectKey && isKnownIssueType` — sonst entstünde ein kaputter Composite-Key bzw. ein `unknown`-Bucket. (`storage-service.ts:148-154,166,265`)
- **HR-7 Self-Write-Suppression.** Jede DOM-Mutation der Extension läuft in `markOwnMutation(...)`, sonst Endlosschleife Observer↔Render. (`content-entry.ts:80,357`)
- **HR-8 Genau eine MutationObserver-Instanz** (`observeRoot`), 300 ms Debounce; Rescans lesen **nie** Storage neu, sie nutzen `currentHiddenFieldIds`. (`content-entry.ts:569-579,136-141`)
- **HR-9 Observer-Filter enthält kein `data-testid`, Settle-Poll-Cap bleibt 100 (~30 s).** Jira setzt die Modal-Testid in einer späteren Attribut-Mutation; niedrigerer Cap = fehlende Icons auf Board-`?selectedIssue=`. (`content-entry.ts:597-607`, `jira-context-resolver.ts:309`)
- **HR-10 Fixed-Rate-Poll darf nicht debounced werden** (wait == period löscht den trailing edge). (`jira-context-resolver.ts:328-338`)
- **HR-11 Resolver wirft nie.** Jeder DOM/URL-Zugriff `try`-gekapselt, Fallback `UNKNOWN_CONTEXT`. (`jira-context-resolver.ts:28,201-240`)
- **HR-12 Scan-Root respektieren.** Feld-/Tab-/Section-/Typ-Scan immer über `getIssueRoot()`, nie `document` — sonst werden Board-Karten hinter dem Panel als Felder gelesen. (`jira-context-resolver.ts:176-199`, `content-entry.ts:222`)
- **HR-13 `GET_FIELDS` wird NICHT auf `isActive` gegatet.** Read-only DOM-Scan; sonst könnte das Popup direkt nach Aktivierung keine Liste zeigen. (`content-entry.ts:626-652`)
- **HR-14 `onPrefsChanged` bleibt auf `isActive` + Seq-Gate + `settling`-Flag.** Fremd-Tab-Writes dürfen einen inaktiven Tab nicht aufwecken; stale Events werden per `waitForWritesToSettle` aufgelöst, nicht verworfen. (`content-entry.ts:656-709`, `storage-service.ts:224-238`)
- **HR-15 `onActivationsChanged` ist Pflicht-Geschwister zu `onPrefsChanged`** — Aktivierung liegt auf einem anderen Key, `onPrefsChanged` feuert dafür nie. (`content-entry.ts:540-553`, `storage-service.ts:377-389`)
- **HR-16 Deaktivieren erhält Prefs**; `clearPrefs()` entfernt nur den Prefs-Key, Activations bleiben. (`storage-service.ts:70-72,365-369`)
- **HR-17 Keine neuen Permissions.** Icon-Graustufe ist eine statische PNG (`icons/icon{16,48}-grey.png`, generiert von `scripts/make-grey-icons.cjs`); `chrome.action.*` braucht keinen Permission-Eintrag. *Verletzt bei:* neuem `tabs`-Permission oder neuem Host-Pattern. (`service-worker.ts:15-24`, `manifest.json:6-12`)
- **HR-18 Keine Test-Hintertür im Produktivcode** (kein `host === 'localhost'`-Bypass); Integrationstests seeden echte Activations. (`tests/integration/setup.ts:49-73`)
- **HR-19 `__jfvLoaded`-Guard bleibt** — SW-Re-Injection darf kein zweites Init erzeugen. (`content-entry.ts:712-715`, `service-worker.ts:51-60`)
- **HR-20 Kein zweiter Message-Typ für Aktivierung.** Fluss ist Popup → Storage → Content. (`popup.ts:79-87`)

## 8. Design System {#design-system}
- Atlassian-ADG-nahe Palette; Fokusring `#4c9aff` mit `outline-offset: 1px` auf `:focus-visible` (`src/content/styles.css:54-57`).
- Klassen-Präfix `jfv-` für alles, was die Extension in fremdes DOM schreibt (`.jfv-field-toggle`, `.jfv-field-toggle--hidden`, `.jfv-debug`, `.jfv-action-button`, `.jfv-primary`, `.jfv-scope-bar`) (`src/content/styles.css:23-87`, `src/popup/popup.css:81-136`); Hidden-Marker-Attribut `data-jfv-hidden="true"` (`src/content/styles.css:19-21`).
- Primärbutton = `.jfv-action-button.jfv-primary` (`src/popup/popup.css:81,109`).
- Light-Mode-Kernfarben (`src/content/styles.css:34-63`): Rahmen `#dfe1e6`, Hintergrund `#fafbfc`, Text `#172b4d`, Hover-Hintergrund `#ebecf0`; Hidden-Zustand Hintergrund `#ffebe6` / Rahmen `#ffbdad` / Text `#bf2600`.
- Dark-Mode (getriggert über `html[data-color-mode='dark']`, Jiras eigenes Theming-Attribut) (`src/content/styles.css:66-87`): Rahmen `#3b4350`, Hintergrund `#1d2125`, Text `#b6c2cf`, Hover-Hintergrund `#2c333a`; Hidden-Zustand Hintergrund `#42221f` / Rahmen `#ff8f73` / Text `#ff8f73`.
- Debug-Outline: `.jfv-debug [data-jfv-host] { outline: 1px dashed #4c9aff; outline-offset: -1px; }` (`src/content/styles.css:81`).

## 9. Bekannt & bewusst akzeptiert
- **Eligible ohne Projekt → S2 mit farbigem Icon**: `/jira/your-work`, `/jira/dashboards`, `/issues` ohne `selectedIssue` sind eligible, haben keinen ProjectKey; ein dritter Icon-Zustand wurde bewusst nicht gebaut (Backlog, s. `docs/PLAN.md` „Zurückgestellt").
- **Activations liegen in `storage.sync`** → Aktivieren auf Gerät A aktiviert stumm auch Gerät B. Umstellung wäre ein One-Liner am Key (`prefs.ts:41`).
- **JSM/next-gen-Projekt-URLs** matchen evtl. `PROJECT_KEY_PATH_REGEX` nicht → sanfter Fallback S2 (`jira-context-resolver.ts:51`).
- **200-ms-Timeout statt ACK** nach Aktivierung (`popup.ts:83-85`).
- **Sync-Quota**: Keys sind ~20 B länger als in v2, `Pref` dupliziert `host`/`projectKey`/`issueTypeId` in den Wert. Degradiert laut (Exception), nicht still (`storage-service.ts:44-48`).
- **Label-Cache unbegrenzt** (`content-entry.ts:120-127`).
- **DOM-Selektoren provisorisch** — Jira-Markup-Änderung degradiert zu `unknown`/leerem Scan statt Fehler (`jira-context-resolver.ts:14-17,53-59`; ausführlicher in `field-registry.ts:6-9` beschrieben).

## 10. Test-Contract (was welche Invariante schützt)
- Unit `storage-service`: Cross-Site- und Cross-Projekt-Isolation, Deaktivieren erhält Prefs, zwei parallele `setActivated`, Key-Trennung der `onChanged`-Listener, `dropLegacyPrefs`-Scope, Write-Guard-No-Ops.
- Unit `jira-context-resolver`: `isEligibleUrl`-Matrix inkl. Suffix-Spoof, `undefined`, `/issuesfoo` (false) und `/issues/` (true); lowercase `host`; Pfad-Fallback-ProjectKey.
- Integration (Puppeteer): laufen durch das **echte** Gate, Activations werden im Harness geseedet (`tests/integration/setup.ts:49-73`); frisches Profil pro Datei, `fileParallelism: false`.
- Manuell nur über **Claude for Chrome** (echtes Profil + geladene `dist/`); `agent-browser` untauglich (`CLAUDE.md`).

## 11. Änderungspolitik
- Spec-Änderung = eigener Commit, Begründung in `docs/CHANGELOG.md`.
- Hard-Rule-IDs sind stabil; entfernte Regel wird als „zurückgezogen (Datum, Grund)" markiert statt gelöscht — sonst brechen Review-Referenzen.

## 12. Build-Targets (Chrome/Firefox)
- Zwei Targets aus demselben `src/`: `npm run build` → `dist/` (Chrome/Chromium), `npm run build:firefox` → `dist-firefox/` (Firefox); `npm run build:all` baut beide (`esbuild.config.mjs:13,15`).
- Drei reale Deltas, sonst identischer Code:
  1. **Background**: Chrome bündelt `service_worker`/ESM (MV3-SW); Firefox hat keinen MV3-Service-Worker, daher `background.scripts` als IIFE (`esbuild.config.mjs:20-23,69`).
  2. **`chrome`-Namespace**: Firefox-Build setzt esbuild `define: { chrome: 'browser' }` statt `webextension-polyfill` einzubinden (`esbuild.config.mjs:44`).
  3. **Manifest-Merge**: `manifest.firefox.json` enthält nur die Deltas (u. a. Pflichtfeld `browser_specific_settings.gecko.id`) und wird zur Build-Zeit flach über `manifest.json` gemerged (`esbuild.config.mjs:65-73`, `manifest.firefox.json:1-6`).
- Grau-Icon (nicht-eligible Tab) ist für **beide** Targets eine statische PNG (`icons/icon{16,48}-grey.png`, generiert von `scripts/make-grey-icons.cjs`) — der frühere OffscreenCanvas-Laufzeitpfad war worker-only und ist entfernt (siehe `docs/CHANGELOG.md`).
- AMO-Submission ist nicht Teil dieses Scopes.

## Anhang: Abweichungen Plan → Code (Code gilt)

| # | Plan sagte | Code macht | Beleg |
|---|-----------|------------|-------|
| 1 | Gate `/jira/` + `/browse/` | zusätzlich `/issues` (exakt bzw. `/issues/…`) | `jira-context-resolver.ts:42-46`, `manifest.json:18`, `service-worker.ts:80` |
| 2 | nur `fieldLabelKey` auf `:v2:` | alle drei Local-Caches auf `:v2:` | `prefs.ts:26-38` |
| 3 | `default_icon` 16/32, fetch `icon32.png` | 16/48, fetch `icon48.png` (kein 32er Asset) | `manifest.json:11`, `service-worker.ts:13,21` |
| 4 | Activations-Load rendert unbedingt | Render nur `if (onIssuePage)`; gleiches Muster bei Settings/Watcher | `content-entry.ts:537,561,566,615-619` |
| 5 | S0 behält Settings-Checkboxen | S0 versteckt `settings-block` | `popup.ts:105` |
| 6 | S4 „keine Feldliste" | Feldlisten-Container sichtbar mit Leertext | `popup.ts:99-103,47-54` |
| 7 | `getPref` „exact → empty" | zusätzlich Kurzschluss `projectKey === null` → leerer Pref mit `projectKey:''` | `storage-service.ts:61-63` |
| 8 | `onInstalled` → `dropLegacyPrefs` | + `reinjectContentScript()` davor | `service-worker.ts:90-94` |

## Offene Lücken (nicht aus Code oder Gliederung ableitbar)
- `README.md`/`PRIVACY.md` wurden für diese SPEC nicht gegengelesen; alle Belege daraus sind aus der Gliederung `.claude/plans/spec-outline-a2a.md` übernommen, nicht re-verifiziert.
