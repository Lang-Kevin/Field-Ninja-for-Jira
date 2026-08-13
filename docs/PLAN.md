# PLAN.md — Wave-Tracker `feat/site-scoped-activation` → merge-ready

Quelle: `.claude/plans/site-scoped-activation-merge.md`. Neue Session: von oben nach unten lesen, beim ersten offenen Kästchen weitermachen.

## Wave A — Hygiene & Guardrails

- [x] A1 · Repo-Hygiene: `.gitignore` deckt `.agents/` pauschal ab, Chrome-Profil/Session-State entfernt.
- [x] A2 · `docs/` anlegen: `docs/SPEC.md`, `docs/CHANGELOG.md`, `docs/PLAN.md` (dieses Dokument) + `CLAUDE.md`-Pfade korrigiert.
- [x] A3 · Plan gespiegelt nach `.claude/plans/site-scoped-activation-merge.md`.

## Wave B — `/issues`-Support + Popup-Settings-Block

- [x] B1 · Review der Working-Tree-Arbeit (Issue-Navigator-Match-Pattern, Popup-Settings-Block).
- [x] B2 · Review-Findings umgesetzt (falls es welche gab).
- [x] B3 · Commits erstellt — siehe `docs/CHANGELOG.md` (`1736620`, `1ab3c4f`, `55c332c`).

## Wave C — Verifikation

- [x] C1 · Automatisches Gate (`npm run typecheck && npm run build && npm run test:unit && npm run test:integration`) — PASS am 2026-08-02: `typecheck` OK, `build` OK, `test:unit` 7 Files / 110 Tests grün, `test:integration` 10 Files / 11 Tests grün. `tests/integration/per-issue-type-isolation.test.ts` hatte einmalig einen 30s-Hook-Timeout, war beim Re-Run und im QA-Lauf stabil grün — vor einer Fehlerdiagnose einmal wiederholen.
- [x] Real-Tenant-Verifikation grün: `node scripts/pw-real.mjs <tenant>.atlassian.net` → 10/10 nach dem `field-registry`-Fix. `/browse/<PROJ>-44` 14 Toggles, Issue-Type real aufgelöst (`<tenant>.atlassian.net:<PROJ>:task`), `?selectedIssue=` 12 Toggles, zweites Projekt nicht mit-aktiviert, keine `[jfv]`-Errors auf bare `/issues`.
- [ ] C2 · Manuelle Browser-Verifikation (Claude for Chrome, 9 Prüfpunkte aus dem Merge-Plan) — Playwright-Harness-Commits (`7b72b7c`, `6d8d399`, `13a6234`) existieren, aber ob alle 9 Zeilen vom User als bestanden bestätigt wurden, ist aus dem Git-Log allein nicht ablesbar.
- [ ] C3 · Auswertung der Fehlschläge aus C1/C2 (falls welche auftreten) via systematischer Root-Cause-Analyse, nicht Symptomfix.
- Verworfener Workaround zum `LABEL_SELECTOR`-Bugfix: Fixture umbenennen, um die Kollision verschwinden zu lassen, wurde abgelehnt — das hätte den Testfall entschärft statt den Produktivcode zu reparieren. Ebenso abgelehnt: die Dedup in `listFields()` aufzuweichen — das tauscht stilles Verschlucken gegen doppelte Toggles auf einem Container. Gefixt wurde stattdessen `findContainer()` (siehe `docs/CHANGELOG.md`).

## Wave D — Integration

- [x] D1 · Security-Review (`@reviewer`, Scope `d507883...HEAD`): Manifest-Permissions, Origin-Prüfungen, Message-Passing. Kein Critical. Origin-Prüfung per Suffix-Check (`hostname.endsWith('.atlassian.net')`), kein Substring-Muster. Genau ein `onMessage`-Listener (`content-entry.ts:626`, `GET_FIELDS`, rein lesend), kein `externally_connectable`, keine `postMessage`-Bridge. Storage-Key injection-dicht: `projectKey` regex-constrained `[A-Z][A-Z0-9]*`, `issueTypeId` slugified, `host` colon-frei. Behoben: echter Tenant-Name und lokaler Windows-Username aus `scripts/pw-real.mjs` entfernt.
  - `host_permissions` bewusst nicht verengt: Aus dem Security-Review kam der Vorschlag, `manifest.json`-Permissions enger zu fassen. Bewusst auf nach dem Merge verschoben — der Install-Prompt für den Nutzer ändert sich dadurch nicht und das Laufzeitverhalten bleibt identisch (der Code gated bereits über den Pfad), aber es riskiert Injection-Bruch und erzwingt kurz vor dem Merge einen frischen Real-Tenant-Lauf.
- [x] D2 · Versionierung: `manifest.json` `version` von `0.1.0` auf `0.2.0` angehoben (`package.json` gleichgezogen), `docs/CHANGELOG.md`-Abschnitt von „Unreleased" auf das Release-Datum umgestellt.
- [x] D2b · Shrink-Cover-Feature (opt-in Cover-Bild-Höhenlimit via `<head>`-Style, Popup-Checkbox + Zahleneingabe) inkl. Final-Review-Fixes umgesetzt — siehe `docs/CHANGELOG.md`.
- [ ] D3 · Merge: `git checkout main && git merge --ff-only feat/site-scoped-activation`, Push nur auf explizite Ansage.

---

## Zurückgestellt

Backlog aus Wave E des Merge-Plans — bewusst nicht Teil dieses Merges:

- **Dritter Icon-State für „eligible, aber nicht aktivierbar"** (`/jira/your-work`, `/jira/dashboards`, `/issues` ohne Projekt) — landen heute in S2 mit farbigem Icon, obwohl nichts zu aktivieren ist.
- **Activations in `storage.sync` statt `storage.local`** — Aktivieren am Laptop aktiviert stillschweigend am Desktop mit; bewusst akzeptiert, widerspricht aber „explizites Opt-in pro Gerät".
- **Sync-Quota**: falls es eng wird, `host`/`projectKey`/`issueTypeId` aus dem `Pref`-Objekt streichen und aus dem Key reparsen.
- **`console.log` in Produktivcode**: `service-worker.ts:91` („installed") ist reines Rauschen und kann weg. `service-worker.ts:46`, `ui-overlay.ts:55`, `content-entry.ts:229` bleiben (bewusste Fehlerkanäle bzw. am Debug-Modus).
