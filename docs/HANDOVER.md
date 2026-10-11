# Handover — 2026-10-09

## Status

Branch `test/cross-browser-e2e` → PR against `main`. Storage v4 code-complete (plan T1–T11 done). `tsc` clean, build + `build:firefox` OK, vitest unit 260/260, integration 11/11. e2e not re-run after storage v4 (needs real tenant).

## Done

Earlier on this branch:
- b845424 refactor(selectors): Jira DOM selectors centralized in `src/lib/jira-selectors.ts`
- 6164e3d feat(popup): wait for activation ACK instead of fixed 200ms sleep
- 6a3328a feat(options): search box filters saved prefs by project
- 861407d test: unit tests for service worker + toggle overlay
- 3301185 test(firefox): `hasSession()` ignores expired session cookies

Storage v4 (spec `docs/superpowers/specs/2026-10-08-storage-v4-design.md`, plan `docs/superpowers/plans/2026-10-09-storage-v4.md`):
- e9353e7 T1 key helpers + `SYNC_QUOTA` (`src/types/prefs.ts`)
- d4b2345, d62cb57 T5 `validateExport` (`src/lib/export-schema.ts`)
- b68e1f2, 91f667f T2 per-project shards `jiraFieldVisibility:v4:${host}:${projectKey}`, `StorageQuotaError`, `getSyncUsage`
- 857ca3a T10 e2e checks + integration seed read v4
- 9d54767 T7 popup usage line + inline quota errors
- d639913 T3 `migrateV3ToV4` + `pruneLocalCaches`
- a0e30ac T6 service worker: migrate → prune → dropLegacy → reinject
- 6738e08, a8a4ae8 T4 `writeBuckets` / `mergeActivations` / `listKnownBuckets` / `buildExport`
- 3b29421, d60512c T8 options usage line, errors, export/import
- 55cfff7, 401f560 T9 "Copy to…" panel + options styles
- 59158b8, f83c004 T11 SPEC (HR-3, HR-21), CHANGELOG, TESTPLAN

## Rejected

Navigation API for SPA detection: `currententrychange` fires synchronously inside `pushState` before Jira re-renders, so the resolver read a stale issue type. The 300ms href poll stays.

## Open

- **Final whole-branch review not done** (aborted by usage limit). Run it on the most capable model over `aaf94ba..HEAD` before merging, then one fix wave.
- Parked minor findings from per-task reviews (candidates for that fix wave):
  - popup `init()` awaits `refreshUsage()` unguarded → a `getSyncUsage` reject skips listener wiring (`src/popup/popup.ts`)
  - `quotaMessage` says "per minute" for the hourly write-rate limit
  - corrupt shard values (`null`/string) throw in `expandShards` / `buildExport` / `pruneLocalCaches` → add one `isShard` guard
  - `migrateV3ToV4`: non-object v3 is never removed, so prune stays disabled; total-quota check also runs when nothing is migrated
  - `writeBuckets` has no `MAX_ITEMS` (512) precheck → misleading "100 KB full" message
  - `mergeActivations` writes even when nothing changed
  - service worker: `pruneLocalCaches` and `tabs.query` not individually guarded
  - `role=status` messages may not be announced when un-hidden in the same tick (options + popup)
  - error text `#de350b` on `#f4f5f7` ≈ 4.1:1 contrast (options + popup)
  - export filename uses the UTC date
- Mixed versions: v3 removal syncs to devices on ≤ 0.4.0, which then show no prefs until they update.

## Known gaps

- Firefox runner has no BiDi console channel, so checks 12/20 miss content-script-world `[jfv]` errors.
- Options search, popup ACK poll, export/import and "Copy to…" are only unit-tested, not e2e.

## User-only

- Review and merge the PR.
- Manual TESTPLAN items 21–25 (storage v4) on the real tenant; `npm run e2e`.
- Chrome Web Store upload (version bump first).
- Cover-shrink check in real Chrome (needs a tenant issue with a cover image).

## Verify

`npm run typecheck && npm run build && npm run build:firefox && npx vitest run && npm run e2e`
