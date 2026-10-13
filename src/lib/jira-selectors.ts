/** Literal Jira DOM selectors, in one place. Never match by localized aria-label text. */
export const JIRA_SELECTORS = {
  // Issue-type badge/icon candidates, tried in order.
  issueType: [
    '[data-testid*="issue-type"]', // unconfirmed
    '[data-testid*="issuetype"]', // unconfirmed
  ],
  // Linked-issue cards inside the panel (skipped when reading the panel's own type).
  issueLineCard: '[data-testid*="issue-line-card"]',
  // Issue detail scope: board modal first, then issue-layout (navigator).
  issueDetailPanel: [
    '[data-testid="issue.views.issue-details.issue-modal.modal-dialog"]',
    '[data-testid*="issue-modal.modal-dialog"]',
    '[data-testid="issue.views.issue-details.issue-layout.issue-layout"]',
    '[data-testid*="issue-details.issue-layout"]',
  ],
  // Field row/section container markers.
  containerMarker:
    '[data-testid*="field"], [data-testid*="-field"], [id^="customfield_"], [class*="customfield"], [role="group"]',
  // Plausible field elements (new + old view).
  field:
    '[data-testid*="field"], [data-testid*="-field"], [id^="customfield_"], [class*="customfield"]',
  // Heading of an empty field. Only one real sample seen.
  fieldHeading: '[data-component-selector*="field-heading"]', // unconfirmed
  // Third-party sidebar app panels.
  panel:
    '[data-testid*="panel"], [data-testid*="-panel"], [data-testid^="issue-view-layout-templates-views.ui.context.visible-hidden.ui.ecosystem-context-group.container."]', // unconfirmed
  // Outer container of a Forge/Connect app section (header + body).
  ecosystemPanel:
    '[data-testid^="issue-view-layout-templates-views.ui.context.visible-hidden.ui.ecosystem-context-group.container."]',
  // Global app-shell nav rail (page chrome).
  globalNavExclude: '[aria-label="Sidebar"]',
  // "Child work items" panel chrome.
  childIssuesExclude:
    '[data-testid*="child-issues-panel"], [aria-label="Child work items section"]',
  // Drag-reorder + collapsible-section layout chrome.
  sortableChromeExclude:
    '[data-testid*="sortable-item-list"], [data-testid*="context-group"], [data-testid*="collapsible-group-factory"]',
  // Collapsible section wrappers.
  section: '[data-testid*="context-group"], [data-testid*="collapsible-group-factory"]',
  // Label element near a field.
  label: 'label, [data-testid*="label"]', // unconfirmed
  // Testid substrings of protected-field wrappers (Summary, Status).
  protectedTestidSubstrings: [
    'issue-field-summary',
    'issue-field-status',
    'ref-spotlight-target-status-spotlight',
  ],
  // ARIA tabs.
  tab: '[role="tab"]', // unconfirmed
  // Panel title sibling.
  panelTitle: '[data-testid$=".title"]',
  // Status field wrapper; its parent is the status row (status, Agents, coding tool, Improve).
  statusFieldWrapper: '[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"]',
  aiAgentsButton: '[data-testid="ai-agents-button.button"]',
  improveIssue: '[data-testid="issue.views.issue-base.foundation.status.improve-issue"]',
  rovoButton: '[data-testid="platform-ai-button"]',
  // Issue cover image: structural match, unscoped, locale-independent.
  cover: 'div[role="img"][aria-label]:empty',
} as const;
