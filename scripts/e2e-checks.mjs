// Browser-agnostic e2e assertions for Field Ninja, run against the seeded test
// tenant (see scripts/jira-seed.mjs + tests/tenant.json). Both launchers
// (Chrome/playwright, Firefox/puppeteer-BiDi) implement the same `driver` shape
// and call runChecks() — so a Chrome/Firefox behaviour divergence shows up as a
// differing pass list, not as two drifting scripts.
//
// The tenant renders in German. Every assertion here must be locale-independent:
// data-testid substrings, our own class names, computed style — never label text.
const SETTLE = 6000; // issue view; the content script debounces 300ms + settle-polls
const NAV_SETTLE = 8000; // issue navigator is slower still

export async function runChecks(d, tenant) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    return ok;
  };
  const skip = (name, why) => {
    results.push({ name, ok: true, skipped: true });
    console.log(`SKIP  ${name}  — ${why}`);
  };

  const ORIGIN = `https://${tenant.host}`;
  const CM = tenant.projects.FNCM;
  const TM = tenant.projects.FNTM;
  const taskKey = CM.sampleIssues.Task;
  const bugKey = CM.sampleIssues.Bug;
  const tmKey = TM.sampleIssues.Task;

  const TOGGLE = '.jfv-field-toggle';
  const HIDDEN = '[data-jfv-hidden]';
  // v4: one sync item per host+project; flatten back to "host:PROJ:type" so checks 6/14/16 are unchanged.
  const scopeKeys = () =>
    d.evalInExt(async () => {
      const all = await chrome.storage.sync.get(null);
      const prefix = 'jiraFieldVisibility:v4:';
      return Object.keys(all)
        .filter((k) => k.startsWith(prefix))
        .flatMap((k) => Object.keys(all[k]).map((t) => `${k.slice(prefix.length)}:${t}`));
    });

  // Every run starts from a clean storage state — a persistent profile would
  // otherwise carry an activation over and silently invert check 1.
  await d.evalInExt(() => chrome.storage.sync.clear());

  // --- FNCM Task: activation + hiding ---------------------------------------
  const issue = await d.newPage();
  await d.goto(issue, `${ORIGIN}/browse/${taskKey}`);
  await d.wait(issue, SETTLE);
  check('1 not activated -> no toggles', (await d.count(issue, TOGGLE)) === 0);

  const popup = await d.newPage();
  await d.goto(popup, d.extUrl('popup.html'));
  await d.refreshPopup?.(popup, issue);
  await d.wait(popup, 800);
  const scope = await d.text(popup, '#scope-label');
  check('2 project key detected (FNCM)', scope.includes('FNCM'), scope);
  check('3 popup offers activation', await d.visible(popup, '#activate-button'));

  await d.click(popup, '#activate-button');
  await d.wait(issue, SETTLE);
  const nToggles = await d.count(issue, TOGGLE);
  check('4 activation applies without reload', nToggles > 0, `${nToggles} toggles`);

  // Protected fields are matched by testid substring in field-registry.ts, which
  // is the locale-independent path — never by the (German) heading text.
  const prot = await d.evalPage(issue, () => {
    const sel = '[data-testid*="issue-field-summary"], [data-testid*="issue-field-status"]';
    const nodes = [...document.querySelectorAll(sel)];
    return { found: nodes.length, withToggle: nodes.filter((n) => n.querySelector('.jfv-field-toggle')).length };
  });
  check(
    '5 Summary/Status have no toggle',
    prot.found > 0 && prot.withToggle === 0,
    `${prot.found} protected containers, ${prot.withToggle} with toggle`
  );

  await d.click(issue, TOGGLE);
  await d.wait(issue, 2500);
  const keysAfterHide = await scopeKeys();
  check(
    '6 issue type resolved, pref written',
    keysAfterHide.length > 0 && !keysAfterHide.some((k) => k.includes('unknown')),
    keysAfterHide.join(', ') || 'nothing written'
  );

  // Hidden state is expressed two ways (shared <style> rule / attribute + css),
  // so computed style is the only assertion that covers both.
  const hiddenNow = () =>
    d.evalPage(issue, () => {
      const els = [...document.querySelectorAll('[data-jfv-hidden]')];
      return { n: els.length, allNone: els.every((e) => getComputedStyle(e).display === 'none') };
    });
  const h7 = await hiddenNow();
  check('7 hidden field computes display:none', h7.n > 0 && h7.allNone, `${h7.n} hidden`);

  await d.goto(issue, `${ORIGIN}/browse/${taskKey}`);
  await d.wait(issue, SETTLE);
  const h8 = await hiddenNow();
  check('8 hidden survives reload', h8.n === h7.n && h8.allNone, `${h8.n} hidden (was ${h7.n})`);

  // --- per-issue-type isolation ---------------------------------------------
  await d.goto(issue, `${ORIGIN}/browse/${bugKey}`);
  await d.wait(issue, SETTLE);
  const bugHidden = await d.count(issue, HIDDEN);
  const bugToggles = await d.count(issue, TOGGLE);
  check('9 other issue type unaffected', bugHidden === 0 && bugToggles > 0, `${bugHidden} hidden, ${bugToggles} toggles`);

  // --- SPA navigation (HR-8) -------------------------------------------------
  // A full goto is not an SPA transition. The issue navigator's row links are
  // real in-app links, so clicking one exercises the pushState path.
  const nav = await d.newPage();
  await d.goto(nav, `${ORIGIN}/issues?jql=${encodeURIComponent(`project=FNCM ORDER BY created ASC`)}`);
  await d.wait(nav, NAV_SETTLE);
  const rowLink = `a[href*="/browse/${taskKey}"]`;
  if ((await d.count(nav, rowLink)) > 0) {
    await d.click(nav, rowLink);
    await d.wait(nav, SETTLE);
    const spa = await d.evalPage(nav, () => ({
      toggles: document.querySelectorAll('.jfv-field-toggle').length,
      hidden: [...document.querySelectorAll('[data-jfv-hidden]')].filter(
        (e) => getComputedStyle(e).display === 'none'
      ).length,
    }));
    check('10 SPA nav re-applies', spa.toggles > 0 && spa.hidden > 0, `${spa.toggles} toggles, ${spa.hidden} hidden`);
  } else {
    skip('10 SPA nav re-applies', 'no in-app link to the sample issue in the navigator');
  }

  // --- issue navigator (HR-12 / HR-9) ---------------------------------------
  await d.goto(nav, `${ORIGIN}/issues?selectedIssue=${taskKey}`);
  await d.wait(nav, NAV_SETTLE);
  const navN = await d.count(nav, TOGGLE);
  check('11 /issues?selectedIssue= -> toggles', navN > 0, `${navN} toggles`);

  const bare = await d.newPage();
  await d.goto(bare, `${ORIGIN}/issues`);
  await d.wait(bare, SETTLE);
  const bareErrs = d.consoleErrors(bare).filter((e) => e.includes('[jfv]'));
  check('12 bare /issues -> no [jfv] error', bareErrs.length === 0, bareErrs.join(' | '));
  await d.close(bare);

  // --- FNTM: separate scope --------------------------------------------------
  const tm = await d.newPage();
  await d.goto(tm, `${ORIGIN}/browse/${tmKey}`);
  await d.wait(tm, SETTLE);
  const tmToggles0 = await d.count(tm, TOGGLE);
  await d.refreshPopup?.(popup, tm);
  await d.wait(popup, 800);
  const scopeTm = await d.text(popup, '#scope-label');
  check('13 second project not activated, scope detected', tmToggles0 === 0 && scopeTm.includes('FNTM'), scopeTm);

  await d.click(popup, '#activate-button');
  await d.wait(tm, SETTLE);
  await d.click(tm, TOGGLE);
  await d.wait(tm, 2500);
  const keysBoth = await scopeKeys();
  const distinctProjects = new Set(keysBoth.map((k) => k.split(':').slice(0, 2).join(':')));
  check('14 scopes are isolated', distinctProjects.size === 2, keysBoth.join(', '));

  // --- options page ----------------------------------------------------------
  const opts = await d.newPage();
  await d.goto(opts, d.extUrl('options.html'));
  await d.wait(opts, 1500);
  const headings = await d.evalPage(opts, () =>
    [...document.querySelectorAll('.jfv-project-heading')].map((h) => h.textContent ?? '')
  );
  const joined = headings.join(' | ');
  check('15 options lists both projects', joined.includes('FNCM') && joined.includes('FNTM'), joined);

  // Two groups on the page — an unscoped click hits the wrong one.
  const clicked = await d.evalPage(opts, () => {
    const g = [...document.querySelectorAll('.jfv-project-group')].find((x) =>
      (x.querySelector('.jfv-project-heading')?.textContent ?? '').includes('FNTM')
    );
    const btn = g?.querySelector('.jfv-deactivate-btn');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await d.wait(opts, 1500);
  await d.goto(tm, `${ORIGIN}/browse/${tmKey}`);
  await d.wait(tm, SETTLE);
  const tmAfter = await d.count(tm, TOGGLE);
  const keysAfterDeact = await scopeKeys();
  check(
    '16 deactivate stops applying but keeps prefs',
    clicked && tmAfter === 0 && keysAfterDeact.some((k) => k.includes(':FNTM:')),
    `${tmAfter} toggles, keys: ${keysAfterDeact.join(', ')}`
  );
  await d.close(tm);
  await d.close(opts);

  // --- settings --------------------------------------------------------------
  await d.evalInExt(() =>
    chrome.storage.sync.set({
      'jiraFieldVisibility:settings:v1': {
        showFieldButtons: false,
        debugOutline: false,
        shrinkCover: true,
        coverHeightPx: 40,
      },
    })
  );
  await d.goto(issue, `${ORIGIN}/browse/${taskKey}`);
  await d.wait(issue, SETTLE);
  const s17 = await d.evalPage(issue, () => ({
    toggles: document.querySelectorAll('.jfv-field-toggle').length,
    hidden: [...document.querySelectorAll('[data-jfv-hidden]')].filter(
      (e) => getComputedStyle(e).display === 'none'
    ).length,
    hasCover: !!document.querySelector('div[role="img"][aria-label]:empty'),
    coverStyle: document.getElementById('jfv-cover-style')?.textContent ?? '',
  }));
  check('17 showFieldButtons=false hides buttons, not fields', s17.toggles === 0 && s17.hidden > 0, `${s17.toggles} toggles, ${s17.hidden} hidden`);

  if (!s17.hasCover) {
    skip('18 shrinkCover applies', 'tenant has no cover image — see docs/TESTPLAN.md');
  } else {
    check('18 shrinkCover applies', s17.coverStyle.includes('40px'), s17.coverStyle.slice(0, 120));
  }

  await d.evalInExt(() =>
    chrome.storage.sync.set({
      'jiraFieldVisibility:settings:v1': {
        showFieldButtons: true,
        debugOutline: false,
        shrinkCover: false,
        coverHeightPx: 80,
      },
    })
  );

  // --- legacy keys / non-eligible URL ---------------------------------------
  const allKeys = await d.evalInExt(async () => Object.keys(await chrome.storage.sync.get(null)));
  const legacy = allKeys.filter((k) => ['jiraFieldVisibility:v1', 'jiraFieldVisibility:v2', 'jiraFieldVisibility:v3'].includes(k));
  check('19 no legacy storage keys', legacy.length === 0, allKeys.join(', '));

  const off = await d.newPage();
  await d.goto(off, `${ORIGIN}/wiki`);
  await d.wait(off, SETTLE);
  const offToggles = await d.count(off, TOGGLE);
  const offErrs = d.consoleErrors(off).filter((e) => e.includes('[jfv]'));
  check('20 non-eligible URL inert', offToggles === 0 && offErrs.length === 0, `${offToggles} toggles, ${offErrs.join(' | ')}`);

  await d.close(off);
  await d.close(nav);
  await d.close(popup);
  await d.close(issue);

  return {
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
  };
}
