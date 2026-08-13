# Changelog

Format: gruppiert nach Feature/Milestone, nicht nach Einzel-Commit. Commit-Hashes in Klammern zur Nachvollziehbarkeit.

## [0.3.0] — 2026-08-13

`manifest.json`/`package.json` auf `0.3.0` angehoben. Minor, weil ein neues Feature dazukommt; bestehende Prefs bleiben unverändert gültig.

### Shrink work item cover

Jira Cloud reserviert für das Work-Item-Cover viel vertikalen Platz oberhalb der Felder. Neue globale Einstellung im Popup (`[x] Shrink work item cover to [80] px`), gespeichert im bestehenden `Settings`-Objekt (`jiraFieldVisibility:settings:v1`) — bewusst global, nicht pro Host/Projekt.

- `syncCoverStyle(px | null)` schreibt ein eigenes `<style id="jfv-cover-style">` in den `<head>`; damit greift der `markOwnMutation`-Vertrag des DOM-Observers nicht (235326a).
- `applyCoverStyle()` in `content-entry.ts` ist ein zweiter `isActive`-Choke-Point neben `render()` — nötig, weil die Settings-/Activation-Callbacks `render()` nur bei `onIssuePage` erreichen. Dokumentiert als Abweichung zu HR-1 (2508e9f, da5ac7c, 38b9e19).
- Der Wert wird debounced auf `input` gespeichert, damit er das Schließen des Popups überlebt; zurückgeschrieben (geklemmt) wird das Feld nur auf `change` (7fcdde4, 6ca65c4).
- Die Regel trifft das Cover (`[role="img"][aria-label$="cover" i]`) **und dessen direktes Elternelement**, damit der reservierte Platz mitschrumpft und das Summary nach oben rutscht. Ein zusätzlicher Großeltern-Selektor kollabierte den gemeinsamen Header-Container und wurde per Playwright-Fixture-Messung wieder entfernt (4e48772, 5d375b8).

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
