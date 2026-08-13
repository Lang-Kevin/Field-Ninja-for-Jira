# Handover — 2026-08-13

State: branch `feat/site-scoped-activation` pushed to origin, version **0.3.0**, package
`field-ninja-0.3.0.zip` built at the repo root. `npm run build` clean, `npx vitest run` 126/0.

Everything in the shrink-cover feature is implemented, reviewed (final whole-branch review plus two
fix rounds) and documented in `docs/CHANGELOG.md` `[0.3.0]`. Two things are still open.

---

## Open point 1 — the cover selector is unverified against the live Jira DOM

**Why it matters.** `syncCoverStyle()` in `src/lib/visibility-engine.ts` shrinks the cover by
injecting a `<head>` stylesheet with two rules:

```css
[role="img"][aria-label$="cover" i]                { height/min-height/max-height: <N>px !important }
:has(> [role="img"][aria-label$="cover" i])        { height/min-height/max-height: <N>px !important }
```

The second rule collapses the cover's **direct parent** so the reserved space disappears and the
summary moves up. Both rules rest on two assumptions that no automated test in this repo can check:

1. The live cover element's `aria-label` **ends in** "cover" (real value seen so far: `Work item cover`).
   A non-English Jira UI breaks this — the `ponytail:` comment on the function says so.
2. The element holding the reserved vertical space is the cover's **direct parent**
   (`css-1q0r35z` in the DOM the user pasted). Emotion class hashes are build-generated and must
   never be used as selectors, which is why `:has()` is used instead.

**History — do not repeat this.** Commit `4e48772` also targeted the *grandparent*
(`:has(> * > …)`). In the live page that collapsed the shared header container and hid the summary
and fields ("everything is missing"). A Playwright fixture reproduced it and `5d375b8` reverted to
direct-parent-only:

| Variant | cover wrapper | outer header | summary top |
| --- | --- | --- | --- |
| img only | 240 (dead space left behind) | 418 | 258 (never moved) |
| img + direct parent — **shipped** | 80 | 258 | 98 (moved up 160) |
| img + parent + grandparent | 2 | 80, clipped everything | 20, crushed |

Reaching further up the ancestor chain is the wrong direction. If the space still does not
collapse, the fix is a **better anchor**, not a deeper one.

**How to verify.** Only Claude for Chrome can do this — it drives the user's real Chrome with the
unpacked `dist/` loaded and a live Jira session. `agent-browser` launches a clean Chromium without
the extension and cannot see any of this (see `CLAUDE.md`). Hand the user this script:

1. Reload the unpacked extension from `dist/`, open a Jira issue that has a cover.
2. Popup → tick "Shrink work item cover", value `80` → cover shrinks immediately, no reload, and
   the summary moves up to meet it.
3. Set `200` → both grow. Set `5` → the field snaps to `20`.
4. Untick → Jira's original height returns, summary back where it was.
5. Disable the site in the popup → original height returns.
6. Console: no `[jfv]` errors; `document.getElementById('jfv-cover-style').textContent` shows two
   selectors and tracks the current setting.
7. Check nothing *else* got squashed — header actions, breadcrumbs, the field list below.

**If it fails**, collect from the live page and report back:

```js
const c = document.querySelector('[role="img"][aria-label*="cover" i]');
c.getAttribute('aria-label');
c.dataset.testid;
// walk up 3 levels: tag, data-testid, and getBoundingClientRect().height for each
```

The fix is then to swap the `aria-label` match for whatever stable `data-testid` Jira exposes, and
to point the ancestor rule at whichever level actually owns the height.

---

## Open point 2 — flaky integration test — **CLOSED 2026-08-13**

Resolved: it was possibility (2), a real product race. Reproduced at 4/26 iterations (~15%).
`onPrefsChanged` in `src/content/content-entry.ts` trusted the `chrome.storage.onChanged` payload,
which can arrive out of order relative to the `issued === committed` write-seq gate, so a stale
event clobbered `currentHiddenFieldIds` through a full toggle-button remount. Fixed in `9e18c88`
(read prefs fresh instead of trusting the event) and `e4692f4` (`renderGen` generation guard, since
the gate check is synchronous but the reload is async). 20/20 looped runs green, suite 126/0.
The test file is byte-identical — no timeout was raised.

**The 0.3.0 zip at the repo root predates these fixes.** Rebuild it before uploading to the CWS.

<details><summary>Original diagnosis (kept for context)</summary>


`tests/integration` → "Rapid toggling (debounce + suppression consistency) settles to a consistent
final visible/hidden state after rapid clicks on multiple fields".

Failed once (`expected true to be false`), passed on an immediate re-run; the full suite is 126/0
on a clean run. It is **not** related to the cover work — nothing in the shrink-cover diff touches
the debounce or the observer-suppression path.

Two possibilities, in order of likelihood:

1. The test races on a timer and is simply under-waited — a test bug.
2. There is a real intermittent inconsistency in the toggle debounce / `markOwnMutation`
   suppression interaction, and the test is correctly catching it about 1 run in N.

Do not "fix" it by raising a timeout until (2) is ruled out. Suggested approach: run that single
test in a loop (`npx vitest run tests/integration -t "Rapid toggling"`, 20+ iterations) to get a
real failure rate, then read the assertion against `dom-observer.ts` and the toggle write path. If
the failure only ever appears under load, it is (1).

</details>

---

## Also worth knowing

- **CWS upload is manual and still pending.** Upload `field-ninja-0.3.0.zip` in the dashboard.
  Permission justifications from `716d37e`/`3fe6355` are unchanged — the cover feature adds no
  permissions. Store assets must never be produced against the real tenant.
- `fail.png` / `needed.png` at the repo root are untracked and were deliberately left alone.
- `.superpowers/sdd/shrink-cover/` (git-ignored) holds the SDD ledger, review packages and
  implementer reports for this feature. Delete it once open point 1 passes.
- `docs/SPEC.md` HR-1 carries a recorded deviation: `applyCoverStyle()` in
  `src/content/content-entry.ts` is a second `isActive` choke point beside `render()`, needed
  because the settings/activation callbacks only reach `render()` when `onIssuePage`. Any new
  global-setting-driven page effect must be gated the same way — every `recomputeActive()` site and
  every settings-changed callback, not just `render()`.
