## Project

**Field Ninja for Jira** (internal repo name: `jira-field-visibility`) is a Chrome Extension (Manifest V3) that lets users hide/show Jira Cloud issue fields on a per-issue-type basis. Preferences persist client-side only via `chrome.storage.sync` — there is no backend and no server-side component.

- Runtime: MV3 service worker (background) + content script injected on `*.atlassian.net` issue pages + an options page.
- Language/build: TypeScript, bundled with esbuild, tested with Vitest (unit) and Puppeteer (integration).
- Core modules (`src/lib/`): `jira-context-resolver.ts` (detect current issue type, SPA-aware), `field-registry.ts` (enumerate DOM fields), `field-id.ts` (stable cross-render field identification), `storage-service.ts` (per-issue-type prefs in `chrome.storage.sync`), `visibility-engine.ts` (apply show/hide to field containers), `ui-overlay.ts` (toggle UI), `dom-observer.ts` (single shared MutationObserver with self-write suppression).
- Storage model: a single `chrome.storage.sync` key (`jiraFieldVisibility:v1`) holding `Record<issueTypeId, { issueTypeId, hiddenFieldIds }>` — keeps writes within quota and isolates prefs per issue type.

**Current build status: see `docs/PLAN.md`** — a checkbox-tracked wave schedule. A new session should read it first and resume from the first unchecked box.

## Plan Storage

Plans created in plan mode for this project must always be saved inside the project folder, at `.claude/plans/`, never in the global `~/.claude/plans/` directory.

## Further Reading

- Full specification: `docs/SPEC.md`
- Design decisions & color palette: `docs/SPEC.md#design-system`
- History (completed milestones, batches, bugfixes): `docs/CHANGELOG.md`

## Testing

Always use the cheapest model when working with Playwright in combination with `/caveman`.

---

General work conventions (model routing, retrieval-first, logs, review strategy, shell, session start, graphify) apply globally — see `~/.claude/CONVENTIONS.md`.