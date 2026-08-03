# Privacy Policy — Field Ninja for Jira

**Last updated: 2026-08-03**

Field Ninja for Jira does not collect, transmit, sell, or share any data.

## What the extension stores

- Only your field-visibility preferences (which fields you've hidden, per
  Jira issue type) are stored, using Chrome's built-in `chrome.storage.sync`
  API.
- This data stays inside Google's Chrome Sync infrastructure for your own
  signed-in Chrome profile — it is never sent to any server operated by us,
  because we don't run one.

## What the extension does NOT do

- No analytics, telemetry, or crash reporting.
- No third-party scripts or trackers.
- No account, sign-up, or login.
- No access to issue content, comments, attachments, or any Jira data beyond
  reading field labels/containers on the page to let you toggle their
  visibility.

## Permissions

- `storage` — to save your hide/show preferences locally and sync them
  across your own Chrome profiles.
- `scripting` — to inject the extension's own content script into a Jira tab
  you have explicitly activated, when Chrome has not already loaded it (for
  example on a tab that was open before installation).
- Host access to `https://*.atlassian.net/*` — the content script only runs
  on Jira Cloud issue pages, where it adjusts the visibility of field
  elements already present in the page DOM.
