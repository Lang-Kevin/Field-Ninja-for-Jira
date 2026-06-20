# Privacy Policy — Field Ninja for Jira

**Last updated: 2026-06-20**

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
- `activeTab` — to let the toolbar icon interact with the current Jira tab.
- Host access to `https://*.atlassian.net/*` — the content script only runs
  on Jira Cloud issue pages, where it adjusts the visibility of field
  elements already present in the page DOM.

## Contact

Questions or concerns: kevinlangprivat@gmail.com
