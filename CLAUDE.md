## Project

**Field Ninja for Jira** (internal repo name: `jira-field-visibility`) is a Chrome Extension (Manifest V3) that lets users hide/show Jira Cloud issue fields on a per-issue-type basis. Preferences persist client-side only via `chrome.storage.sync` — there is no backend and no server-side component.

- Runtime: MV3 service worker (background) + content script injected on `*.atlassian.net` issue pages + an options page.
- Language/build: TypeScript, bundled with esbuild, tested with Vitest (unit) and Puppeteer (integration).
- Core modules (`src/lib/`): `jira-context-resolver.ts` (detect current issue type, SPA-aware), `field-registry.ts` (enumerate DOM fields), `field-id.ts` (stable cross-render field identification), `storage-service.ts` (per-issue-type prefs in `chrome.storage.sync`), `visibility-engine.ts` (apply show/hide to field containers), `ui-overlay.ts` (toggle UI), `dom-observer.ts` (single shared MutationObserver with self-write suppression).
- Storage model: a single `chrome.storage.sync` key (`jiraFieldVisibility:v1`) holding `Record<issueTypeId, { issueTypeId, hiddenFieldIds }>` — keeps writes within quota and isolates prefs per issue type.

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

## Browser Automation (agent-browser)

Authenticated Jira session is saved at `C:\Users\Kiwi PC\.agent-browser\states\jira-auth.json`.

**Usage:**
```bash
agent-browser --state "C:\Users\Kiwi PC\.agent-browser\states\jira-auth.json" --session jira open "<jira-url>"
```

**Re-authenticate** (when cookies expire): run `agent-browser --headed --session jira open "https://lynqtech.atlassian.net"`, log in manually, then `agent-browser --session jira state save "C:\Users\Kiwi PC\.agent-browser\states\jira-auth.json"`.

---

General work conventions (model routing, retrieval-first, logs, review strategy, shell, session start, graphify) apply globally — see `~/.claude/CONVENTIONS.md`.