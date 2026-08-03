## Project

**Field Ninja for Jira** (internal repo name: `jira-field-visibility`) is a Chrome Extension (Manifest V3) that lets users hide/show Jira Cloud issue fields on a per-issue-type basis. Preferences persist client-side only via `chrome.storage.sync` — there is no backend and no server-side component.

- Runtime: MV3 service worker (background) + content script injected on `*.atlassian.net` issue pages + an options page.
- Language/build: TypeScript, bundled with esbuild, tested with Vitest (unit) and Puppeteer (integration).
- Core modules (`src/lib/`): `jira-context-resolver.ts` (detect current issue type, SPA-aware), `field-registry.ts` (enumerate DOM fields), `field-id.ts` (stable cross-render field identification), `storage-service.ts` (per-issue-type prefs in `chrome.storage.sync`), `visibility-engine.ts` (apply show/hide to field containers), `ui-overlay.ts` (toggle UI), `dom-observer.ts` (single shared MutationObserver with self-write suppression).
- Storage model: a single `chrome.storage.sync` key (`jiraFieldVisibility:v3`) holding `Record<'${host}:${projectKey}:${issueTypeId}', Pref>` — keeps writes within quota and isolates prefs per site, project, and issue type. Older `:v1`/`:v2` keys are legacy and are dropped (never migrated) on install.

**Current build status: see `docs/PLAN.md`** — a checkbox-tracked wave schedule. A new session should read it first and resume from the first unchecked box.

## Agents & Delegation

**Caveman is mandatory.** The main session works in caveman-compressed format at all times. Every sub-agent runs caveman too — **except `@implementer`, which runs ponytail** (laziest working solution, shortest diff).

**The main agent does not do work a sub-agent can do.** The main session is reserved for architecture decisions, multi-file design, hard bug hypotheses, and trade-off calls. Searching, focused edits, reviews, and verification are delegated — never run Grep-dumps, point-fixes, or test sweeps inline if an agent covers them.

| Agent          | Model  | Primary function |
| -------------- | ------ | ---------------- |
| `@explorer`    | —      | Codebase investigation: graphify-first, then Grep/Glob. Returns only relevant `file:line` references — no dumps. |
| `@implementer` | Sonnet | Focused code change in ≤3 clearly-scoped files (bugfix, small feature, planned wave item). Returns diff summary. |
| `@reviewer`    | Sonnet | Read-only review of the latest diff vs. spec/hard rules/architecture. Runs after every change, before commit. |
| `@architect`   | Opus   | Milestone/wave planning, multi-file architecture, cross-layer bug hypotheses. Returns a plan, not code. |
| `@qa-verifier` | Haiku  | Read-only PASS/FAIL gate after each milestone and before merge/PR: build + lint + tests + acceptance criteria. |

## Plan Storage

Plans created in plan mode for this project must always be saved inside the project folder, at `.claude/plans/`, never in the global `~/.claude/plans/` directory.

## Further Reading

- Full specification: `docs/SPEC.md`
- Design decisions & color palette: `docs/SPEC.md#design-system`
- History (completed milestones, batches, bugfixes): `docs/CHANGELOG.md`

## Testing

Always use the cheapest model when working with Playwright in combination with `/caveman`.

## Browser Testing (Claude for Chrome)

Test the extension with **Claude for Chrome**, driven in the user's real Chrome — it has the unpacked `dist/` extension loaded and a live authenticated Jira session, so it sees the actual extension runtime (toggle icons, content-script console). This is the only way to observe the built extension in situ.

`agent-browser` does NOT work for this project: it launches a clean Chromium without the extension, so it can only inspect Jira's DOM, never the extension's own behaviour. Do not use it to verify extension UI.

The main session cannot drive Claude for Chrome directly — hand the user a precise, self-contained test script (URL + exact checks: `.jfv-field-toggle` count, `window.__jfvLoaded`, any `[jfv]` console errors) and have the results relayed back.

---

General work conventions (model routing, retrieval-first, logs, review strategy, shell, session start, graphify) apply globally — see `~/.claude/CONVENTIONS.md`.