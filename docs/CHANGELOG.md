# Changelog

Format: gruppiert nach Feature/Milestone, nicht nach Einzel-Commit. Commit-Hashes in Klammern zur Nachvollziehbarkeit.

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

### Board-view fixes & per-project prefs (Vorstufe, bereits vor site-scoped activation auf diesem Branch)

- Field-Toggle-UI leakte auf die Jira-Board-Ansicht hinein; Scan-Root auf das Issue-Panel eingeschränkt (`172da65`).
- Board-Panel setzt sein `data-testid` erst spät — Toggles wurden dadurch teils gar nicht gemountet, gefixt über den Settle-Poll (`279cfa1`).
- Field-Visibility-Prefs werden ab hier per Projekt-Schlüssel getrennt statt global pro Issue-Type (`d78aed4`).
- Browser-Testing-Doku auf Claude for Chrome umgestellt, da `agent-browser` die Extension-Runtime nicht sieht (`e2361bb`).
- Field-Toggles mounten jetzt zuverlässig bei SPA-Navigation innerhalb des Boards (`07d9e0f`).
- Hidden-Fields-Verwaltung pro Issue-Type in die Options-Seite verlegt (`9cd2127`).

---

Diff-Basis: `git log d507883..HEAD` (Merge-Base zu `main`, umfasst die beiden oben genannten Features).
