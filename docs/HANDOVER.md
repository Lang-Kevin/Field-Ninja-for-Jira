# Handover — 2026-10-09

## Status

Branch `test/cross-browser-e2e`, unpushed. `tsc` clean, build OK, vitest 148/148, e2e Chrome 20/20 + Firefox 20/20 (check 18 skipped, tenant has no cover).

## Done

- b845424 refactor(selectors): Jira DOM selectors centralized in `src/lib/jira-selectors.ts`
- 6164e3d feat(popup): wait for activation ACK instead of fixed 200ms sleep
- 6a3328a feat(options): search box filters saved prefs by project
- 861407d test: unit tests for service worker + toggle overlay
- 3301185 test(firefox): `hasSession()` ignores expired session cookies
- 12afdf3 chore: spike script removed; 89984b8 docs: stale PLAN.md removed

## Rejected

Navigation API for SPA detection (#4): `currententrychange` fires synchronously inside `pushState` before Jira re-renders, so the resolver read a stale issue type. The 300ms href poll stays.

## In progress

Storage v4: per-project sync shards, one-time v3→v4 migration, quota display, JSON export/import, "Copy to…".
- Spec: `docs/superpowers/specs/2026-10-08-storage-v4-design.md` (approved 2026-10-09)
- Plan: `docs/superpowers/plans/2026-10-09-storage-v4.md` (being written)

## Known gaps

- Firefox runner has no BiDi console channel, so checks 12/20 miss content-script-world `[jfv]` errors.
- Options search and popup ACK poll are only unit-tested, not e2e.

## User-only

- Push branch.
- Chrome Web Store 0.4.0 upload.
- Cover-shrink check in real Chrome (needs a tenant issue with a cover image).

## Verify

`npm run build && npx vitest run && npm run e2e`
