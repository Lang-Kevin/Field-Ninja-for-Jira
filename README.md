# 🥷 Field Ninja for Jira

**Hide the Jira fields you never use. Per issue type. One click. Nothing leaves your browser.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](manifest.json)
[![No backend](https://img.shields.io/badge/backend-none-brightgreen.svg)](PRIVACY.md)

Jira issue screens get cluttered fast — every team adds custom fields, and
half of them are noise for the issue type you're actually looking at. Field
Ninja lets you hide any field with one click, remembers your choice per
issue type (hiding *Story Points* on a Story doesn't touch Epics or Bugs),
and needs zero Jira admin permissions to use.

https://github.com/user-attachments/assets/8df1581d-57e7-4b6a-8fa7-2004cf545f1f

## Features

- **Per-field toggle** — a small eye icon appears next to every field; click
  to hide or show it instantly.
- **Per-issue-type memory** — preferences are scoped to issue type, so your
  Bug view and your Epic view stay independent.
- **Control panel** — a toolbar-triggered panel lists every field on the
  current issue for bulk show/hide.
- **Protected fields** — core fields like *Summary* and *Status* can't be
  hidden by accident.
- **Zero backend** — preferences live in `chrome.storage.sync`, scoped to
  your own signed-in Chrome profile. No account, no server, no tracking.
  See [PRIVACY.md](PRIVACY.md).

## Install

**From the Chrome Web Store:** *(listing pending — link goes here once published)*

**From source (development/testing):**

1. `npm install`
2. `npm run build` — bundles `src/` into `dist/`
3. Open `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked**, select the `dist/` folder
6. Open any Jira Cloud issue (`https://<your-site>.atlassian.net/browse/...`)
   — eye icons appear next to each field, and the toolbar icon opens the
   panel

## Usage

- Click the eye icon next to a field to hide/show just that field.
- Click the toolbar icon to open the panel and manage all fields for the
  current issue type at once.
- Visibility is remembered per issue type.
- Settings persist across reloads and sync across your Chrome profiles.

## Privacy

Field Ninja for Jira collects nothing. No analytics, no accounts, no remote
servers — your preferences never leave Chrome's own sync storage. Full
details: [PRIVACY.md](PRIVACY.md).

## Development

```bash
npm run dev            # esbuild --watch
npm run typecheck      # tsc --noEmit
npm test                # unit + integration tests (vitest)
npm run test:unit
npm run test:integration
```

After editing source files, re-run `npm run build` (or keep `npm run dev`
running) and click the reload icon for the extension on `chrome://extensions`
to pick up changes.

See `CLAUDE.md` for the module map and `docs/PLAN.md` for build status.

## Contributing

Issues and PRs welcome — this is a small, focused extension, so keep changes
scoped and add tests for any logic in `src/lib/`.

## License

[MIT](LICENSE)
