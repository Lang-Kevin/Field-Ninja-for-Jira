# Handover — 2026-08-13

State: everything below is merged into `main`, version **0.4.0** (Firefox build target added,
see `docs/CHANGELOG.md` `[0.4.0]`). `npm run build` clean, `npx vitest run` 129/0 as of 0.3.0 —
the browser check for open point 1 is still outstanding.

Everything in the shrink-cover feature is implemented, reviewed (final whole-branch review plus two
fix rounds) and documented in `docs/CHANGELOG.md` `[0.3.0]`. Two things are still open.

**The stale `field-ninja-0.3.0.zip` has been deleted** — it predated the race fix and the locale
fix. Build a fresh zip from `dist/` for any CWS upload; there is no packaging script.

`main` now carries the Firefox port and the cover-selector fix; `feat/site-scoped-activation` and
`feat/firefox-port` are merged into it and can be deleted.

---

## Open point 1 — cover selector — **selector fixed, browser check still open**

**Measured against the live German Jira on 2026-08-13.** Assumption 1 below was **broken** and is
now fixed in `b23dac3`; assumption 2 **held** and is unchanged. What remains open is only the
visual confirmation in the browser (the script under "How to verify").

**Why it matters.** `syncCoverStyle()` in `src/lib/visibility-engine.ts` shrinks the cover by
injecting a `<head>` stylesheet with two rules:

```css
div[role="img"][aria-label]:empty              { height/min-height/max-height: <N>px !important }
:has(> div[role="img"][aria-label]:empty)      { height/min-height/max-height: <N>px !important }
```

The second rule collapses the cover's **direct parent** so the reserved space disappears and the
summary moves up. The two assumptions these rest on, and what the live page said:

1. ~~The live cover element's `aria-label` **ends in** "cover"~~ — **false on any non-English Jira.**
   The German label is `Vorgangstitelbild`, which contains no "cover" substring at all, so the
   feature was silently a no-op on every localized instance. A per-locale suffix list is not viable
   (Jira ships ~25 languages). Replaced with a **structural** match that reads no label text: on the
   live page the cover was the only `div[role="img"]` that *has* an `aria-label` and has zero
   children (1031×120); all 15 others were assignee avatars with `aria-label` **absent** and 2
   children each (28×28). No usable `data-testid` exists on the cover or its first two ancestors —
   the nearest is `issue.views.issue-details.issue-layout.issue-layout` at height 830, i.e. exactly
   the container `4e48772` broke. Do not anchor there.
2. The element holding the reserved vertical space is the cover's **direct parent** — **confirmed**:
   the direct parent measured height 120, matching the cover's own 1031×120. Emotion class hashes
   (`css-1q0r35z`) are build-generated and must never be used as selectors, which is why `:has()`
   is used instead.

**Known residual risk** (review finding, accepted): the structural selector is not scoped to the
issue header, so any *other* empty `div[role="img"]` carrying an `aria-label` would also be
shrunk. Jira renders icon badges with an `<svg>` child, which `:empty` excludes, and the live page
showed zero collisions across all 16 `div[role="img"]` elements. Scoping to the issue-layout
`data-testid` was rejected: that is the container from `4e48772`, and it may be absent in the board
modal — scoping wrongly would silently reintroduce the exact no-op bug just fixed. **Step 7 of the
verification script is what detects this**; treat it as load-bearing, not a formality.

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

**If it fails**, collect from the live page and report back — note this enumerates *all* candidates
rather than assuming a label, which is how the locale bug above was found:

```js
[...document.querySelectorAll('div[role="img"]')].forEach((e, i) => {
  const r = e.getBoundingClientRect();
  console.log(i, JSON.stringify(e.getAttribute('aria-label')), `${r.width|0}x${r.height|0}`,
              'kids', e.childNodes.length, e.dataset.testid);
});
// then, on whichever index is the cover, walk up 5 levels logging
// tag, data-testid, and getBoundingClientRect().height for each
```

If the cover matches but the space does not collapse, the fix is a **better anchor**, not a deeper
one — see the grandparent table above. If an unrelated element got squashed, narrow the selector
(scope it to a stable ancestor that is *not* the issue-layout container), do not loosen it.

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

- **CWS upload is manual and still pending.** Zip `dist/` as 0.4.0 and upload it in the dashboard.
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
