# Chrome Web Store listing — Field Ninja for Jira

Copy-paste source for the developer dashboard. Version `0.2.0`.

Nothing here may contain real tenant, project, issue or person data — the
listing is public. Screenshots come from `scripts/store-shots.mjs`, which drives
the built extension against the synthetic fixture `tests/fixtures/store-demo.html`
(fictional `acme.atlassian.net` / ACME Demo Project / DEMO-42).

## Upload package

`build/field-ninja-0.2.0.zip` — built from `dist/` after `npm run build`, minus
`*.map` and `icons/icon_1024.png`. Rebuild it whenever `dist/` changes.

## Store listing tab

**Name**

```
Field Ninja for Jira
```

**Short description** (132 char max — this is 108)

```
Hide the Jira issue fields you never use. Per issue type, per project, saved in your browser.
```

**Detailed description**

```
Jira issue views collect fields. Sprint, Story Points, Fix versions, half a dozen custom
fields your team filled in once — all of it between you and the two things you actually read.

Field Ninja puts a small eye button next to every field on a Jira Cloud issue. Click it and
the field is gone. Click it in the popup and it is back.

What it does
• Hide or show any field on a Jira Cloud issue view.
• Preferences are per issue type — hiding Story Points on a Bug does not touch your Stories.
• Scoped per site and project, so different projects keep different layouts.
• Works on the issue view, the issue navigator (/issues) and board detail panels.
• Popup with checkboxes for every detected field, plus Hide all / Show all / Reset.
• Options page listing everything you have hidden, across every project.
• Explicit opt-in: the extension does nothing until you press "Enable here" on a project.

What it does not do
• No account, no sign-up, no server. There is no backend.
• No analytics, no telemetry, no trackers.
• It never reads issue content, comments or attachments — only the field labels and
  containers it needs in order to hide them.
• It never changes anything in Jira. Hiding a field is purely visual, in your browser.
  Your teammates see the unchanged issue, and nothing is written back to Atlassian.

Your preferences are stored with Chrome's own storage.sync, so they follow your signed-in
Chrome profile and nothing else.

Works with Jira Cloud (*.atlassian.net). Jira Server / Data Center is not supported.
```

**Category**: Workflow & Planning
**Language**: English

## Graphic assets

| Asset | File | Size |
| --- | --- | --- |
| Store icon | `dist/icons/icon128.png` | 128×128 |
| Screenshot 1 | `build/store/1-toggles.png` | 1280×800 |
| Screenshot 2 | `build/store/2-hidden.png` | 1280×800 |
| Screenshot 3 | `build/store/3-options.png` | 1280×800 |
| Screenshot 4 | `build/store/4-popup.png` | 1280×800 |

Suggested captions (optional field in the dashboard):

1. A hide button on every field of the issue view.
2. The same issue with Sprint, Story Points, Due date and Fix versions hidden.
3. The options page: everything you have hidden, per project and issue type.
4. The popup: toggle any field, or reset the whole project.

## Privacy tab

**Single purpose description**

Paste each block as one paragraph — the line breaks below are for reading only.
Every field has a 1000-character limit.

```
Field Ninja lets a user hide and show individual fields on Jira Cloud issue pages, and
remembers that choice per site, project and issue type. Every part of the extension — the
toggle buttons on the issue view, the popup, and the options page — serves only that
purpose. Hiding is purely visual and local to the browser: nothing is written back to Jira
and no data leaves the browser.
```

**Permission justifications**

- `storage`

  ```
  Stores the user's own show/hide choices — one entry per site, project and issue type —
  so the same fields stay hidden on the next page load. This is the extension's only
  persisted state. Nothing else is written, and the data never leaves the user's Chrome
  profile because the extension has no backend of any kind.
  ```

- `scripting`

  ```
  Injects the extension's own bundled content script and stylesheet into a Jira Cloud tab
  that the user has explicitly activated, in the case where Chrome has not already loaded
  them — for example a tab that was open before the extension was installed, or before the
  user pressed "Enable here". Without it those tabs would silently do nothing until a
  manual reload. Only files shipped inside the extension package are injected; no remote
  code is ever executed.
  ```

- Host permission `https://*.atlassian.net/*`

  ```
  The extension only works on Jira Cloud, which is always served from *.atlassian.net, so
  https://*.atlassian.net/* is the narrowest pattern that covers every user's tenant —
  tenant names are per-customer and cannot be known in advance. The content script needs
  access to that origin to locate the field labels and containers on an issue page and
  change their CSS visibility. It reads nothing beyond the label text needed to identify a
  field, never issue content, comments or attachments, and transmits nothing anywhere. The
  extension requests no other host.
  ```

**Remote code**: answer **No**. `dist/` contains only the esbuild bundles — no `eval()`,
no `new Function`, no dynamic `import()`, no external `<script src>` or stylesheet.
Answering yes here triggers a review the extension does not need.

**Data usage declarations** — none of the categories apply. Check:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**

```
https://github.com/Lang-Kevin/Field-Ninja-for-Jira/blob/main/PRIVACY.md
```

## Distribution

Public, all regions. Not a paid item, no in-app purchases.

## Pre-submit checklist

- [ ] `npm run typecheck && npm run build && npm run test:unit && npm run test:integration` green.
- [ ] `manifest.json` version bumped and matching `package.json`.
- [ ] `build/field-ninja-0.2.0.zip` rebuilt from the current `dist/`.
- [ ] Screenshots regenerated if any UI string changed (`node scripts/store-shots.mjs`).
- [ ] `PRIVACY.md` permission list matches `manifest.json`.
- [ ] No real tenant, project key, issue key or person anywhere in the repo, the ZIP or
      the screenshots.
