# Storage v4 — design spec (2026-10-08)

Scope: #1 shard prefs + v3→v4 migration + quota surfacing, #2 local-cache pruning, #6 export/import, #7 "Copy to…".
Mode: ponytail — smallest design that works. Decisions 1–4 come from the user and are not reopened here.
Precondition: the uncommitted WIP on `test/cross-browser-e2e` (options/popup/content/ui-overlay) is committed or stashed before T2. Several tasks touch those files.

## 1. Storage keys & schema

| Key (area) | Value | Status |
|---|---|---|
| `jiraFieldVisibility:v4:${host}:${projectKey}` (sync) | `PrefShard = Record<issueTypeId, string[]>` (hiddenFieldIds, deduped, non-empty) | **new**: one item per scope. Remove the item when it is empty |
| `jiraFieldVisibility:v3` (sync) | old `PrefsStore` | read **only** by `migrateV3ToV4`, then removed |
| `jiraFieldVisibility:activations:v1` (sync) | `Record<scope, true>` | unchanged |
| `jiraFieldVisibility:settings:v1` (sync) | `Settings` | unchanged |
| `…:v1`, `…:v2` (sync) | — | still dropped, never read (HR-3) |
| `jfv-{field-labels,tab-fields,section-fields}:v2:${host}:${project}:${type}` (local) | caches | unchanged format. Pruned (§4) |

- Value carries no `host`/`projectKey`/`issueTypeId` duplication. The key encodes them, which saves about 60 B per bucket compared with v3.
- Key parsing is safe because `host` = hostname (no port, no `:`) and `projectKey` matches `[A-Z][A-Z0-9_]*`. Split on the **first** `:` after the prefix.
- **Public API shape is unchanged**: `loadPrefs(): PrefsStore` (`Record<'host:proj:type', Pref>`) is assembled from all shards. options/popup/content compile without edits.
- `getPref` reads exactly one shard (`get(shardKey)`), not all of sync.
- `prefs.ts` stays the only owner of key format. New exports: `PREFS_V4_PREFIX`, `PREFS_V3_STORAGE_KEY`, `makeShardKey(host, project)`, `parseShardKey(key) → {host, projectKey} | null`, `parseScopeKey(scope)`, `LOCAL_CACHE_PREFIXES`, `scopeOfLocalCacheKey(key) → scope | null`, `type PrefShard`, `SYNC_QUOTA = { perItem: chrome.storage.sync.QUOTA_BYTES_PER_ITEM ?? 8192, total: chrome.storage.sync.QUOTA_BYTES ?? 102400 }`. The `??` fallback is there because Firefox may not expose the constants. `PREFS_STORAGE_KEY` is removed in T2.

## 2. storage-service API (delta)

| Function | Behaviour | Chain |
|---|---|---|
| `loadPrefs()` | `sync.get(null)`, filter `PREFS_V4_PREFIX`, expand to `PrefsStore` | — |
| `getPref(h,p,t)` | single-shard read. Null project → empty pref (unchanged) | — |
| `toggleField`, `setHiddenFields` | RMW on **one shard**. Empty shard → `sync.remove(shardKey)` | `enqueueWrite` |
| `clearPref(h,p,t)` | now **inside** `enqueueWrite`. Today it does an unserialized RMW, which is a latent race | `enqueueWrite` |
| `clearPrefs()` | remove every `PREFS_V4_PREFIX*` key. Activations and settings stay (HR-16) | `enqueueWrite` |
| `onPrefsChanged(cb: () => void)` | fires if **any** changed key starts with `PREFS_V4_PREFIX`. The callback gets no snapshot, because content-entry already ignores it and re-reads | — |
| `writeBuckets(buckets: Pref[], mode: 'replace'\|'union')` | bulk primitive for import (`replace`) and Copy-to (`union`). Read-merge happens in memory, then quota precheck (per item + total), then **one** `sync.set`. Every bucket must pass `isWritableScope` (HR-6) or it is skipped | `enqueueWrite` |
| `mergeActivations(scopes: string[])` | union into the activations item with one `set` | `activationsWriteChain` |
| `listKnownBuckets()` | `{host, projectKey, issueTypeId}[]` = v4 buckets ∪ label-cache keys (local). Filter `isKnownIssueType`, dedupe, sort | — |
| `buildExport()` | `ExportFileV1` from shards + activations + settings | — |
| `getSyncUsage()` | `{bytes, quota}`. Own count Σ utf8(key)+utf8(JSON(value)) over `get(null)`, which is Chrome's formula. **No `getBytesInUse`**, because Firefox support is unverified | — |
| `migrateV3ToV4()`, `pruneLocalCaches()` | §3, §4. SW only | none (see HR-4) |
| `StorageQuotaError`, `quotaMessage(e)` | §5 | — |

All `sync.set`/`remove` calls go through one private `syncSet()`/`syncRemove()` that rethrows browser quota errors as `StorageQuotaError`.

## 3. Migration v3 → v4

Runs in the SW only: `onInstalled` (any reason, because `install` can see a v3 item synced from another device) and `onStartup`. Order inside the handler: **migrate → prune → dropLegacyPrefs → reinjectContentScript**. Migration now runs before reinjection, so new content scripts read v4. A content script that reads early self-heals: the shard write fires `onPrefsChanged` and triggers a re-render.

`migrateV3ToV4(): Promise<{ migrated: number; skipped: number }>`
1. `all = sync.get(null)`. If `all[V3]` is missing or not a plain object, return `{0,0}`. This existence check is the only marker and is what makes the function idempotent.
2. For each v3 value, validate `host`/`projectKey` as non-empty strings, `isKnownIssueType(issueTypeId)`, and `hiddenFieldIds` as `string[]`. Malformed entries add to `skipped` and are logged with `[jfv]`. Trust the value fields, not the composite key.
3. Group by `makeShardKey(host, projectKey)`. `shard = { ...(all[shardKey] ?? {}) }`. For each type: **fill-missing only**. If `!(type in shard)` and the list is non-empty, set `shard[type] = dedupe(list)`. v4 wins on conflict.
4. Precheck every changed shard against `SYNC_QUOTA.perItem`, and the whole result against `SYNC_QUOTA.total`. On overflow, throw `StorageQuotaError` **before any write**. v3 stays untouched and the next startup retries.
5. `sync.set({ ...changedShards })`. This is **one** call, so it is atomic and counts as one write op.
6. Only after step 5 resolves: `sync.remove(V3)`.
7. Crash between 5 and 6: the next run's step 3 is a no-op for types already copied, then step 6 runs. Crash before 5: v3 is intact, nothing is lost.

Concurrency:
- In the SW context, the SW is the only prefs writer, so the migration needs no chain and the seq counters stay meaningful (HR-4).
- Cross-context: a content-tab toggle can land between steps 1 and 5 and be overwritten. This is a one-time window of milliseconds right after update, and it follows the same last-write-wins rule the system already accepts (SPEC §5/HR-14). It goes into §9 as accepted.
- Mixed versions over sync: a device still on ≤0.4.0 sees empty prefs after migration. Its next write re-creates v3, which the next `onStartup` merges with fill-missing. Documented, not engineered around.

## 4. Local-cache pruning (#2)

Pick: **drop cache entries whose `host:project` has no v4 shard and no activation.** Rejected alternative: a cap of N entries by lastSeen.
- Why 1: caches are written only from `render()`, which sits behind the `isActive` gate (HR-1). Growth therefore comes only from scopes the user abandoned. Scope-liveness is exactly the right key and needs no new metadata.
- Why 2: an LRU cap would need a `lastSeen` field per cache write (format change + an extra write) and could evict labels that options still needs to name hidden fields in kept scopes.

`pruneLocalCaches()`:
1. `sync.get(null)`. **If `V3` is still present, return**, because migration is pending and pruning now would wipe the caches of every v3-only scope.
2. `keep` = scopes of non-empty v4 shards ∪ activation keys.
3. `local.get(null)` → keys where `scopeOfLocalCacheKey(k)` is non-null and not in `keep`.
4. `local.remove(stale)` if the list is non-empty. Best effort: catch and log.

## 5. Error handling & quota surfacing

- `class StorageQuotaError extends Error { kind: 'item' | 'total' | 'rate'; scope?: string; bytes?: number; limit?: number }`.
- Own prechecks (shard write, `writeBuckets`, migration) throw `'item'`/`'total'` before the browser is called.
- `syncSet` maps browser errors by message: `/QUOTA_BYTES_PER_ITEM/` → item, `/MAX_(SUSTAINED_)?WRITE_OPERATIONS/` → rate, `/QUOTA_BYTES|quota/i` → total. The last one covers Firefox's generic `QuotaExceededError`. Anything else is rethrown unchanged.
- `quotaMessage(e): string | null` is the single source for user text, for example "PROJ on acme.atlassian.net has too many hidden fields (8.3 KB > 8 KB per project)", "Sync storage full (100 KB)" or "Too many changes per minute — try again shortly". It returns null for non-quota errors.
- **Popup**: new `#storage-usage` line ("Sync storage: 3.1 of 100 KB"), visible in all states and styled as a warning at ≥80%. New `#storage-error` (`role="alert"`, hidden by default). Every awaited write in popup.ts (hide all, show all, row toggles, reset all, activate) catches the error and shows `quotaMessage(e) ?? 'Saving failed.'`. This replaces the `alert('Too many fields…')`.
- **Options**: the same two elements above the list. The usage line refreshes after every render.
- **Content script**: no new UI, because HR-1 forbids it. `ui-overlay.ts:52` keeps `console.error('[jfv] …')`. The popup's usage line is the place the user sees it. Known gap that stays out of scope: an optimistic DOM toggle is not rolled back when persisting fails.

## 6. Export / import (#6)

Export file (`field-ninja-export-YYYY-MM-DD.json`, Blob + `<a download>`, so the `downloads` permission is not needed — HR-17):
```json
{ "format": "field-ninja-for-jira", "version": 1, "exportedAt": "<ISO>",
  "prefs": { "<host>:<PROJ>": { "<issueTypeId>": ["<fieldId>", "..."] } },
  "activations": ["<host>:<PROJ>"],
  "settings": { "showFieldButtons": true, "debugOutline": false, "shrinkCover": false, "coverHeightPx": 80 } }
```
Import mode: **merge, file wins per issue-type bucket** (`writeBuckets(…, 'replace')`). Buckets not in the file are kept, activations are unioned, and settings are overwritten if present. Why: it is non-destructive and idempotent (re-importing is a no-op), and it shares the `writeBuckets` primitive with Copy-to. Full replace would need a destructive "remove all shards" step plus a stronger confirmation.

`validateExport(raw: unknown)` lives in the new pure module `src/lib/export-schema.ts`, which has no `chrome.*` calls, so HR-5 holds. It returns `{ok:true, data, summary} | {ok:false, error}`. Strict rules; any violation rejects the **whole** file with `"<path>: <reason>"`:
- Top level: plain object with key set ⊆ {format, version, exportedAt, prefs, activations, settings}. Required: format, version, prefs, activations. Unknown keys are rejected.
- `format === 'field-ninja-for-jira'`, `version === 1`, `exportedAt` is a string if present.
- Every object key anywhere must not be `__proto__`, `constructor` or `prototype`. Output is built into fresh objects, never by assigning file objects.
- `prefs` keys match `^[a-z0-9-]+(\.[a-z0-9-]+)*:[A-Z][A-Z0-9_]*$` (≤300 chars). Type keys: 1–100 chars, no control chars, `isKnownIssueType`. Field lists: arrays of ≤500 strings, each 1–200 chars, deduped. An empty list skips the bucket and is not an error.
- `activations`: an array of ≤512 strings matching the same scope regex.
- `settings` (optional): exactly the 4 `Settings` keys. Three booleans plus `coverHeightPx`, an integer in 20–600 (popup input range).
- `summary = { projects, buckets, fields, activations, hasSettings }`.

Import flow (options):
1. `<input type="file" accept="application/json">`. Check `file.size ≤ 256 KB` **before** reading.
2. `JSON.parse` (guarded) → `validateExport`. On error, put the message in `#storage-error` and write nothing.
3. `confirm("Import N projects, M issue types, K hidden fields, A activations[, settings]? Matching issue types are overwritten, others kept.")`.
4. `writeBuckets(replace)`. Its quota precheck makes overflow abort before any write.
5. `mergeActivations`, then `saveSettings` if present.
6. If step 4 succeeds but step 5 fails, show "Prefs imported; activations/settings failed: …". This is deliberate, because prefs are the quota-bound part. Re-render afterwards.

## 7. Copy to… (#7)

- Every pref row in options gets a "Copy to…" button. It toggles an inline `<fieldset class="jfv-copy-panel">` with one checkbox per `listKnownBuckets()` target, excluding the source. Label: `host — PROJ — Titleized type`. The panel has Copy and Cancel buttons.
- Copy runs `writeBuckets(targets.map(t => ({...t, hiddenFieldIds: src.hiddenFieldIds})), 'union')`, shows "Copied to N issue type(s)", then re-renders.
- **Union**, not overwrite: it is non-destructive, needs no confirm, and repeating it is idempotent. Field ids that don't exist in the target are inert.
- There is no new scope model and no link: it is a one-time copy. Errors are shown through `quotaMessage`.

## 8. SPEC.md changes (German, since SPEC.md is German; its own commit per §11)

**HR-3**: replace the whole line
> - **HR-3 Keine Migration alter Prefs.** v1/v2 werden gelöscht, nie gelesen/gemerged. *Verletzt bei:* jedem Lesezugriff auf `LEGACY_PREFS_KEYS`. (`storage-service.ts:33-36,402-411`)

with
> - **HR-3 Keine Migration von v1/v2; genau eine Migration v3→v4.** v1/v2 werden gelöscht, nie gelesen/gemerged. `jiraFieldVisibility:v3` wird ausschließlich von `migrateV3ToV4()` gelesen: Fill-missing-Merge in die v4-Shards (v4 gewinnt pro Issue-Type), v4 in **einem** `set` schreiben, v3 erst **danach** entfernen, idempotent (Existenz von v3 = einziger Marker); Aufruf nur aus dem SW (`onInstalled` jeder Reason, `onStartup`), vor `reinjectContentScript`. *Verletzt bei:* jedem Lesezugriff auf `LEGACY_PREFS_KEYS`; jedem Lesezugriff auf `PREFS_V3_STORAGE_KEY` außerhalb `migrateV3ToV4`/`pruneLocalCaches` (dort nur Existenzcheck); `remove(v3)` vor aufgelöstem v4-`set`.

- **HR-4** append: "Prefs-Writes = `toggleField`, `setHiddenFields`, `clearPref`, `clearPrefs`, `writeBuckets` (Import/Copy-to) — alle über `enqueueWrite`. `mergeActivations` nutzt `activationsWriteChain`. `migrateV3ToV4` läuft nur im SW (dort kein weiterer Prefs-Writer) und hängt an keiner Chain."
- **HR-5** append: "Options liest Label-Cache und Known-Buckets nur über storage-service (`loadFieldLabels`, `listKnownBuckets`); `src/lib/export-schema.ts` ist rein (kein `chrome.*`)."
- **HR-16** reword: "`clearPrefs()` entfernt alle `jiraFieldVisibility:v4:*`-Shards; Activations bleiben."
- **HR-21 (new)**: "**HR-21 Import ist Trust-Boundary.** Datei läuft vollständig durch `validateExport()` (exakte Key-Menge, Typen, Längen, Regex, kein `__proto__`/`constructor`/`prototype`); alles-oder-nichts; Quota-Precheck vor jedem Write; Merge = Datei gewinnt pro Issue-Type-Bucket, übrige Buckets bleiben. *Verletzt bei:* Write aus ungeprüften Dateidaten oder Teil-Import nach Validierungsfehler."
- **§3**: retitle to "Storage-Schema v4". Replace the key list with the table in §1 (in German). Replace the quota bullet with the §5 text. Local caches: "Pruning per Scope-Liveness im SW". Line 10 "Stand:" → "Storage v4".
- **§4**: options row → "Verwaltung aller Scopes, Export/Import, Copy-to". New row `src/lib/export-schema.ts` | "reine Validierung der Exportdatei" | "`chrome.*` aufrufen".
- **§9**:
  - "Sync-Quota" → "8 KB pro Scope-Shard, 100 KB gesamt; Overflow → `StorageQuotaError`, Popup/Options zeigen Belegung".
  - "Label-Cache unbegrenzt" → "Local-Caches pro toter Scope geprunt, kein LRU; aktiver Scope behält alle Issue-Types".
  - New: "Migration vs. parallelem Tab-Write: einmaliges LWW-Fenster akzeptiert".
  - New: "Gerät mit ≤0.4.0 sieht nach Migration leere Prefs; seine Writes erzeugen v3 neu → Fill-missing-Merge beim nächsten `onStartup`".
- **§10**: add migration (idempotent, crash between set/remove, set fails → v3 intact, v4 wins), prune (v3 present → no-op), the `validateExport` matrix, and `writeBuckets` replace/union + quota precheck.

## 9. File-by-file change list

| File | Change |
|---|---|
| `src/types/prefs.ts` | new key helpers/constants (§1). Delete `PREFS_STORAGE_KEY` (T2) |
| `src/lib/storage-service.ts` | v4 shard I/O, quota error/usage, migration, prune, bulk APIs, export builder (§2–§5) |
| `src/lib/export-schema.ts` (new) | `ExportFileV1`, `EXPORT_FORMAT`, `validateExport` (§6) |
| `src/background/service-worker.ts` | onInstalled + onStartup: migrate → prune → dropLegacy (onInstalled only) → reinject |
| `src/popup/popup.ts`, `popup.html` | usage + error lines, catch all writes (§5) |
| `src/options/options.ts`, `.html`, `.css` | usage/error, export/import, Copy-to panel (§5–§7) |
| `src/content/content-entry.ts` | comment at `:~135` only ("unbounded" → see `pruneLocalCaches`) |
| `scripts/e2e-checks.mjs` | read prefs via the `jiraFieldVisibility:v4:` prefix, not `:v3`. Legacy check also asserts no `:v3` |
| `tests/integration/options-grouping.test.ts` | seed v4 shards instead of the v3 key |
| `docs/SPEC.md`, `CHANGELOG.md`, `TESTPLAN.md` | §8. Changelog entry. TESTPLAN: manual export/import, Copy-to and v3 upgrade check |

## 10. Task breakdown

Chain: `T1 → T2 → T3 → T4 → T8 → T9`. T5 needs only T1. T6 needs T3. T7 and T10 need T2. T11 comes last.
Parallel waves (file-disjoint): **W1** T1 · **W2** T2 ∥ T5 · **W3** T3 ∥ T7 ∥ T10 · **W4** T4 ∥ T6 · **W5** T8 · **W6** T9 · **W7** T11.

| ID | Task | Files (≤3) | After | Acceptance (command, raw output) |
|---|---|---|---|---|
| T1 | Key helpers + quota constants (§1). Keep `PREFS_STORAGE_KEY` for now | `src/types/prefs.ts`, `tests/unit/prefs.test.ts` (new) | — | `npx vitest run tests/unit/prefs.test.ts && npm run typecheck`: make/parse round-trip, `parseShardKey` rejects foreign keys, `scopeOfLocalCacheKey` for 3 prefixes + junk |
| T2 | v4 core: shard load/getPref/toggle/setHidden, `clearPref` into the queue, `clearPrefs` prefix remove, `onPrefsChanged` prefix, `syncSet` + `StorageQuotaError` + `quotaMessage`, `getSyncUsage`. Delete `PREFS_STORAGE_KEY` | `src/lib/storage-service.ts`, `src/types/prefs.ts`, `tests/unit/storage-service.test.ts` | T1 | `npx vitest run tests/unit/storage-service.test.ts && npm run typecheck && npm test`: isolation tests ported to shards; empty shard removed; per-item overflow → `StorageQuotaError('item')` with no write; 3 browser-message mappings; `onPrefsChanged` fires for a v4 key, not for activations/settings |
| T3 | `migrateV3ToV4` + `pruneLocalCaches` (§3, §4) | `src/lib/storage-service.ts`, `tests/unit/storage-migration.test.ts` (new) | T2 | `npx vitest run tests/unit/storage-migration.test.ts && npm run typecheck`: idempotent (2 runs = same state); `set` resolves before `remove` (call order); remove throws → rerun is clean; set throws → v3 intact; v4 wins on conflict; other types in the shard kept; malformed v3 entry skipped; overflow → throws, no write; prune is a no-op while v3 exists; prune keeps prefs/activation scopes and drops the rest |
| T4 | Bulk: `writeBuckets(replace\|union)`, `mergeActivations`, `listKnownBuckets`, `buildExport` | `src/lib/storage-service.ts`, `tests/unit/storage-bulk.test.ts` (new) | T3 | `npx vitest run tests/unit/storage-bulk.test.ts && npm run typecheck`: replace vs union; exactly one `set`; total precheck aborts with no write; `unknown` type skipped; activation union in one write |
| T5 | `validateExport` + `ExportFileV1` (§6) | `src/lib/export-schema.ts` (new), `tests/unit/export-schema.test.ts` (new) | T1 | `npx vitest run tests/unit/export-schema.test.ts && npm run typecheck`: valid fixture → summary counts; one rejection per rule (unknown top key, version≠1, `__proto__` key, bad scope regex, `unknown` type, non-string id, 501 ids, bad settings key/range) |
| T6 | SW: onInstalled/onStartup order (§3), each step try/catch + `[jfv]` log | `src/background/service-worker.ts`, `tests/unit/service-worker.test.ts` | T3 | `npx vitest run tests/unit/service-worker.test.ts && npm run typecheck`: call order migrate → prune → dropLegacy → reinject; a migration rejection still leads to reinject |
| T7 | Popup usage + error lines; catch every write; remove `alert` | `src/popup/popup.ts`, `src/popup/popup.html`, `tests/unit/popup.test.ts` | T2 | `npx vitest run tests/unit/popup.test.ts && npm run typecheck`: `setHiddenFields` rejects with `StorageQuotaError` → `#storage-error` shows the `quotaMessage` text; usage text rendered |
| T8 | Options: usage/error lines, Export, Import (size → parse → validate → confirm → writeBuckets/mergeActivations/saveSettings) | `src/options/options.ts`, `src/options/options.html`, `tests/unit/options.test.ts` | T4, T5 | `npx vitest run tests/unit/options.test.ts && npm run typecheck`: invalid file → error, no write spy called; confirm=false → no write; valid → `writeBuckets(…,'replace')` |
| T9 | Options Copy-to panel (§7) | `src/options/options.ts`, `src/options/options.css`, `tests/unit/options.test.ts` | T8 | `npx vitest run tests/unit/options.test.ts && npm run typecheck`: targets exclude the source; Copy → `writeBuckets(…,'union')` with the checked targets |
| T10 | Harness to v4 + content comment | `scripts/e2e-checks.mjs`, `tests/integration/options-grouping.test.ts`, `src/content/content-entry.ts` | T2 | `npm run build && npx vitest run tests/integration/options-grouping.test.ts && npm run typecheck` |
| T11 | Docs (§8) | `docs/SPEC.md`, `docs/CHANGELOG.md`, `docs/TESTPLAN.md` | all | `@reviewer` spec audit: HR-3/4/5/16/21 text present; every new `file:line` resolves |

Final gate (`@qa-verifier`): `npm run typecheck && npm test && npm run build:all`, then `npm run e2e` (20/20 Chrome + Firefox; one-time login required). Manual check in Claude for Chrome: install 0.4.0, seed v3 → load the new `dist/` as an update → prefs intact, no `jiraFieldVisibility:v3` left in sync. In the same pass, check export/import in Firefox.

## 11. Risks / out of scope
- No spike. Firefox quota constants and `getBytesInUse` are sidestepped with `??` fallbacks and our own byte count. Export uses Blob + `a[download]` from the tab-opened `options_page`, which needs no permission.
- Out of scope: rolling back the optimistic content DOM when persisting fails; a total-quota precheck on single toggles (the browser error is mapped instead); version bump to 0.5.0 (release task).
