// End-to-end test: loads the extension in Chromium, records a flow by really
// using test/playground.html, turns it into a data-driven plan, runs it, and
// exercises editing, the picker, import sanitizing and restricted pages.
// Saves screenshots to test-results/ and store screenshots to store/.
// Run: npm run e2e
//
// Headless Chromium can't click the permission prompt, so the test loads a
// copy of the extension whose manifest pre-grants http://127.0.0.1/* only.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, '.playwright', 'e2e');
const ext = join(work, 'ext');
const out = join(root, 'test-results');

rmSync(work, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const p of ['manifest.json', 'src', 'icons']) cpSync(join(root, p), join(ext, p), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
// Screenshot steps need all-sites access (Chrome's rule for captureVisibleTab);
// pre-grant it here too, since the prompt can't be clicked headlessly.
manifest.host_permissions = ['http://127.0.0.1/*', '<all_urls>'];
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

// Serves only the known test pages (no path traversal).
const PAGES = new Set(['playground.html', 'search.html', 'results.html', 'article.html', 'slow.html']);
// slow.png is held for 10 s, like a slow ad or tracker that delays "load".
const held = new Set();
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  if (name === 'slow.png') {
    held.add(res);
    setTimeout(() => { held.delete(res); res.end(); }, 10000);
    return;
  }
  if (!PAGES.has(name)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(readFileSync(join(root, 'test', name)));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const pageUrl = `${base}/playground.html`;

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  headless: true,
  channel: 'chromium',
  viewport: { width: 900, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

// The extension CSP forbids eval, so poll with evaluate() instead of waitForFunction().
async function waitUntil(page, fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!(await page.evaluate(fn))) {
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${fn}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const PERF_BUDGET_MS = Number(process.env.PERF_BUDGET_MS || 3000);
const ok = (msg, ...rest) => console.log(`✓ ${msg}`, ...rest);
let failed = false;

try {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const panelUrl = `chrome-extension://${extId}/src/sidepanel/index.html`;
  for (let i = 0; i < 50 && !(await sw.evaluate(() => Boolean(globalThis.chrome?.windows))); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // ---- Drag-and-drop in a regular tab (Playwright can't drive native drags
  // in windows created by an extension).
  {
    const tab = await context.newPage();
    await tab.setViewportSize({ width: 380, height: 860 });
    await tab.goto(panelUrl);
    await tab.waitForSelector('#runBtn svg');
    assert.equal(await tab.isVisible('#emptyState'), true, 'empty state shown for a new plan');
    await tab.screenshot({ path: join(out, 'panel-empty.png') });
    await tab.click('#emptyAddBtn');
    await tab.click('#addMenu button:has-text("Click")');
    await tab.click('#addBtn');
    await tab.click('#addMenu button:has-text("Wait")');
    const tabCards = tab.locator('#blockList > li');
    await tabCards.last().locator('.grip').dragTo(tabCards.first(), { targetPosition: { x: 80, y: 4 } });
    assert.equal(await tabCards.first().locator('.block-title strong').textContent(), 'Wait', 'drag moved Wait to top');
    ok('drag-and-drop reorder');
    for (let i = 0; i < 2; i++) {
      await tabCards.first().hover();
      await tabCards.first().locator('.icon-btn.danger').click();
      await tabCards.first().locator('.icon-btn.danger').click();
    }
    assert.equal(await tabCards.count(), 0);
    ok('delete with inline confirm');
    await tab.waitForTimeout(400);
    await tab.close();
  }

  const site = context.pages()[0] || await context.newPage();
  await site.goto(pageUrl);
  await site.bringToFront();

  // Open the panel in its own unfocused window so the playground stays the active tab.
  const panelPromise = context.waitForEvent('page');
  await sw.evaluate((url) => chrome.windows.create({ url, type: 'popup', focused: false, width: 400, height: 860 }), panelUrl);
  const panel = await panelPromise;
  panel.on('pageerror', (e) => console.error('panel error:', e.message));
  panel.on('console', (m) => { if (m.type() === 'error') console.error('panel console:', m.text()); });
  await panel.setViewportSize({ width: 380, height: 860 });
  await panel.waitForSelector('#runBtn svg');
  await site.bringToFront();
  await waitUntil(panel, () => !document.getElementById('siteChip').hidden, 5000);
  ok('panel sees playground with site access:', await panel.textContent('#siteChip'));

  const cards = panel.locator('#blockList > li.block');
  const titles = () => panel.locator('#blockList .block-title strong').allTextContents();

  // ---- Record a flow by really using the page (trusted input events).
  await panel.click('#emptyRecordBtn');
  await site.waitForSelector('clickflow-recorder', { state: 'attached' });
  await panel.waitForSelector('.rec-hint');
  await panel.screenshot({ path: join(out, 'panel-recording-empty.png') });

  await site.click('#bump');
  await site.click('#name');
  await site.keyboard.type('alice');
  await site.click('#email');
  await site.keyboard.type('alice@x.com');
  await site.focus('#country');
  await site.keyboard.press('j'); // native select: typing picks "Japan"
  await site.click('#cityBtn');
  await site.click('#cityList .opt:has-text("City 5")');
  await site.waitForTimeout(300);
  await site.screenshot({ path: join(out, 'site-recording.png') });
  await panel.screenshot({ path: join(out, 'panel-recording.png') });
  await site.click('#submit');
  await waitUntil(panel, () => document.querySelectorAll('#blockList > li.block').length >= 7);
  await panel.click('#recordBtn');
  await site.waitForSelector('clickflow-recorder', { state: 'detached' });
  await waitUntil(panel, () => !document.getElementById('recordBtn').classList.contains('recording'));

  assert.deepEqual(await titles(), ['Click', 'Type text', 'Type text', 'Select / find in list', 'Click', 'Select / find in list', 'Click']);
  const summaries = await panel.locator('#blockList .summary').allTextContents();
  // Form fields are recorded by their name attribute (ids can be generated).
  assert.match(summaries[1], /alice.*input\[name="name"\]/);
  assert.match(summaries[2], /alice@x\.com.*input\[name="email"\]/);
  assert.match(summaries[3], /Japan.*select\[name="country"\]/);
  assert.match(summaries[5], /City 5.*#cityList/);
  assert.deepEqual(await site.locator('#log li').allTextContents(), ['name=alice email=alice@x.com country=jp city=City 5']);
  ok('recorded 7 steps from real page use:', summaries);

  // ---- Text box 1 and text box 2 each get their own data set via the Value dropdown.
  await cards.nth(1).locator('.block-title strong').click();
  assert.equal(await cards.nth(1).locator('.source-select').inputValue(), '__fixed__');
  await cards.nth(1).locator('.source-select').selectOption('__new__');
  await cards.nth(2).locator('.block-title strong').click();
  await cards.nth(2).locator('.source-select').selectOption('__new__');
  assert.equal(await cards.nth(1).locator('.source-select').inputValue(), 'name');
  assert.equal(await cards.nth(2).locator('.source-select').inputValue(), 'email');
  assert.equal(await cards.nth(1).locator('.uses-set code').textContent(), 'name');
  ok('Value dropdown created data sets "name" and "email" from the recorded text');

  // The other text box can switch between sets from the same dropdown.
  await cards.nth(2).locator('.source-select').selectOption('name');
  assert.equal(await cards.nth(2).locator('.uses-set code').textContent(), 'name');
  await cards.nth(2).locator('.source-select').selectOption('email');

  // ---- Data tab: one list per data set.
  await panel.click('#tab-data');
  const setNames = () => panel.locator('.ds-name').evaluateAll((els) => els.map((e) => e.value));
  assert.deepEqual(await setNames(), ['name', 'email']);
  const sets = panel.locator('.dataset');
  assert.equal(await sets.nth(0).locator('textarea').inputValue(), 'alice');
  await sets.nth(0).locator('textarea').fill('alice\nbob\ncarol');
  await sets.nth(1).locator('textarea').fill('a@x.com\nb@x.com');
  assert.equal(await sets.nth(0).locator('.ds-count').textContent(), '3 values');
  assert.equal(await sets.nth(1).locator('.ds-count').textContent(), '2 values');
  assert.equal(await sets.nth(0).locator('.ds-used').count(), 1, 'marked as in use');

  // Add, rename and delete a data set.
  await panel.click('#addDatasetBtn');
  assert.deepEqual(await setNames(), ['name', 'email', 'list']);
  await sets.nth(2).locator('.ds-name').fill('cities');
  await sets.nth(2).locator('.ds-name').press('Enter');
  assert.deepEqual(await setNames(), ['name', 'email', 'cities']);
  await sets.nth(2).locator('.icon-btn.danger').click();
  assert.deepEqual(await setNames(), ['name', 'email']);
  await panel.screenshot({ path: join(out, 'panel-data.png') });
  ok('data sets: separate lists, add / rename / delete');

  // ---- Settings: automatic run count = shortest data set; or a fixed number.
  await panel.click('#tab-settings');
  assert.equal(await panel.getAttribute('#runsMode [data-value="auto"]', 'aria-checked'), 'true', 'automatic by default');
  assert.equal((await panel.textContent('#runBtn')).trim(), 'Run 2×', 'auto: shortest set (email) has 2 values');
  assert.match(await panel.textContent('#autoRunsInfo'), /2 runs.*shortest of your 2 data sets, email, has 2 values/);
  assert.equal(await panel.isVisible('#fixedRuns'), false);
  await panel.screenshot({ path: join(out, 'panel-settings-auto.png') });
  await panel.click('#runsMode [data-value="fixed"]');
  assert.equal(await panel.inputValue('#runs'), '2', 'fixed starts from the automatic count');
  await panel.click('#quickRuns button[data-runs="10"]');
  assert.equal(await panel.inputValue('#runs'), '10');
  await panel.click('#quickRuns button[data-runs="3"]');
  assert.equal((await panel.textContent('#runBtn')).trim(), 'Run 3×');
  await panel.fill('#stepDelay', '50');
  await panel.locator('#stepDelay').dispatchEvent('change');
  await panel.fill('#runDelay', '100');
  await panel.locator('#runDelay').dispatchEvent('change');
  await panel.screenshot({ path: join(out, 'panel-settings.png') });
  ok('runs: automatic = shortest data set (2); fixed number via quick buttons');
  await panel.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await panel.locator('.about').scrollIntoViewIfNeeded();
  assert.match(await panel.textContent('#appVersion'), /^v\d+\.\d+\.\d+$/);
  assert.equal(await panel.getAttribute('.about a', 'href'), 'mailto:lqhuy2309@gmail.com');
  await panel.screenshot({ path: join(out, 'panel-about.png') });
  ok('settings: About card shows the version and the author email');
  await panel.click('#tab-steps');

  // ---- Run 3 times (fixed): each text box takes the next value from its own
  // list; the shorter email list starts over.
  await panel.click('#runBtn');
  await site.waitForFunction(() => document.querySelectorAll('#log li').length === 4, null, { timeout: 60000 });
  await waitUntil(panel, () => document.getElementById('runStatus').textContent.startsWith('Done'), 20000);
  const log = await site.locator('#log li').allTextContents();
  assert.deepEqual(log.slice(1), [
    'name=alice email=a@x.com country=jp city=City 5',
    'name=bob email=b@x.com country=jp city=City 5',
    'name=carol email=a@x.com country=jp city=City 5',
  ]);
  ok('3 runs with two independent data sets:', log.slice(1));
  // The activity log opened by itself and has one ✓ line per step (3 runs × 7 steps).
  assert.equal(await panel.isVisible('#logPanel'), true);
  assert.equal(await panel.locator('#logList .log-item.ok').count(), 21);
  assert.match(await panel.locator('#logList .log-item.ok').nth(1).textContent(), /R1·S2.*alice.*input\[name="name"\].*\d+ ms/);
  assert.match(await panel.textContent('#logSummary'), /Finished · 3\/3 runs ok/);
  ok('activity log: 21 step lines with timings');
  await panel.screenshot({ path: join(out, 'panel-done.png') });
  await site.screenshot({ path: join(out, 'playground-after.png') });

  // ---- Move up / down.
  await cards.nth(3).hover();
  await cards.nth(3).locator('[aria-label="Move up"]').click();
  assert.equal((await titles())[2], 'Select / find in list');
  await cards.nth(2).hover();
  await cards.nth(2).locator('[aria-label="Move down"]').click();
  assert.deepEqual(await titles(), ['Click', 'Type text', 'Type text', 'Select / find in list', 'Click', 'Select / find in list', 'Click']);
  ok('move up/down');

  // ---- A missing element fails with a readable error on that step.
  await cards.last().locator('.block-title strong').click();
  await cards.last().locator('.input-group input').fill('#does-not-exist');
  // Clear the recorded text backup ("Submit"), or the step would still succeed.
  await cards.last().locator('.field', { hasText: 'If not found' }).locator('input').fill('');
  await panel.click('#tab-settings');
  await panel.fill('#timeout', '500');
  await panel.locator('#timeout').dispatchEvent('change');
  await panel.click('#quickRuns button[data-runs="1"]');
  await panel.click('#tab-steps');
  await panel.click('#runBtn');
  await panel.waitForSelector('.block.is-error .block-error', { timeout: 20000 });
  assert.match(await panel.textContent('.block.is-error .block-error'), /does-not-exist/);
  ok('error surfaced on the failing step:', await panel.textContent('.block-error'));
  await panel.screenshot({ path: join(out, 'panel-error.png') });

  // ---- Element picker fills a selector without clicking the page.
  const countBefore = await site.textContent('#counter');
  await panel.click('#addBtn');
  await panel.click('#addMenu button:has-text("Click")');
  await cards.last().locator('.pick-btn').click();
  await site.waitForSelector('clickflow-picker', { state: 'attached' });
  await site.evaluate(() => window.scrollTo(0, 0));
  const box = await site.locator('#bump').boundingBox();
  await site.mouse.move(box.x + 5, box.y + 5);
  await site.screenshot({ path: join(out, 'picker.png') });
  await site.mouse.click(box.x + 5, box.y + 5);
  await waitUntil(panel, () => document.querySelector('#blockList > li.block:last-child .input-group input')?.value === '#bump');
  assert.equal(await site.textContent('#counter'), countBefore, 'picker click must not reach the page');
  ok('element picker filled "#bump" without triggering the page');

  // ---- Hostile import is sanitized and rendered as text.
  const evil = join(work, 'evil.json');
  writeFileSync(evil, JSON.stringify({
    name: '<img src=x onerror="document.title=\'pwned\'">',
    blocks: [{ type: 'click', selector: '<script>x</script>' }, { type: 'eval', code: 'alert(1)' }],
  }));
  await panel.click('#planMenuBtn');
  const chooser = panel.waitForEvent('filechooser');
  await panel.click('[data-action="import"]');
  await (await chooser).setFiles(evil);
  await panel.waitForSelector('dialog[open]');
  assert.match(await panel.textContent('dialog'), /1 unsupported step/);
  await panel.click('dialog button[type=submit]');
  assert.equal(await panel.evaluate(() => document.querySelectorAll('img[src="x"]').length), 0);
  assert.notEqual(await panel.title(), 'pwned');
  ok('hostile import sanitized, no markup injected');

  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.click('#planSelect');
  await panel.selectOption('#planSelect', { index: 0 });
  await panel.waitForTimeout(400);
  await panel.screenshot({ path: join(out, 'panel-dark.png') });
  await panel.emulateMedia({ colorScheme: 'light' });

  // ================= Google-like search site =================
  // Regression tests for: Enter not submitting a <textarea> search box with
  // no submit button, keyCode-checking handlers, generated ids/classes, and
  // the recorder missing actions (Enter in a textarea, mousedown-only
  // suggestions, typing right before a navigation).
  const newPlanNamed = async (name) => {
    await panel.click('#planMenuBtn');
    await panel.click('[data-action="new"]');
    await panel.fill('dialog input', name);
    await panel.click('dialog button[type=submit]');
    await panel.waitForSelector('#emptyState:not([hidden])');
  };
  const openSite = async (path) => {
    await site.goto(`${base}/${path}`);
    await site.bringToFront();
    await waitUntil(panel, () => !document.getElementById('siteChip').hidden, 5000);
  };
  const recorderReady = () => site.waitForSelector('clickflow-recorder', { state: 'attached', timeout: 10000 });
  const stopRecording = async () => {
    await panel.click('#recordBtn');
    await waitUntil(panel, () => !document.getElementById('recordBtn').classList.contains('recording'));
  };
  const runAndWait = async () => {
    await panel.evaluate(() => { document.getElementById('runStatus').textContent = ''; });
    await panel.click('#runBtn');
    await waitUntil(panel, () => /^(Done|Finished|Stopped)/.test(document.getElementById('runStatus').textContent), 30000);
    return panel.textContent('#runStatus');
  };

  // ---- Selector builder ignores generated ids/classes.
  await openSite('results.html?q=cats');
  await site.addScriptTag({ path: join(root, 'src', 'content', 'selector.js') });
  const built = await site.evaluate(() => ({
    box: window.__clickflowSelector.build(document.querySelector('textarea')),
    link: window.__clickflowSelector.build(document.querySelector('.r a')),
    generated: ['ti6dpd', 'C6AK7c', ':r3:', 'ember1234', 'submit-btn', 'searchBox', 'main']
      .map(window.__clickflowSelector.looksGenerated),
  }));
  assert.equal(built.box, 'textarea[name="q"]', 'form field uses its name, not the random id');
  assert.equal(built.link, 'a[href="article.html?title=cats-1"]', 'link uses its href, not obfuscated classes');
  assert.deepEqual(built.generated, [true, true, true, true, false, false, false]);
  ok('selector builder prefers name/href and skips generated ids/classes');

  // ---- Record: type in a <textarea>, press Enter (no submit button), click a result.
  await newPlanNamed('Search flow');
  await openSite('search.html');
  await panel.click('#emptyRecordBtn');
  await recorderReady();
  await site.click('textarea[name=q]');
  await site.keyboard.type('cats');
  await Promise.all([site.waitForURL(/results\.html\?q=cats/), site.keyboard.press('Enter')]);
  await recorderReady();
  await Promise.all([site.waitForURL(/article\.html/), site.click('text=cats — result 1')]);
  await recorderReady();
  await stopRecording();
  assert.deepEqual(await titles(), ['Type text', 'Click']);
  await cards.nth(0).locator('.block-title strong').click();
  assert.equal(await cards.nth(0).locator('.input-group input').first().inputValue(), 'textarea[name="q"]');
  assert.equal(await cards.nth(0).locator('textarea').inputValue(), 'cats');
  assert.equal(await cards.nth(0).locator('.check', { hasText: 'Press Enter' }).locator('input').isChecked(), true,
    'Enter in a textarea search box was recorded');
  await cards.nth(1).locator('.block-title strong').click();
  assert.equal(await cards.nth(1).locator('.input-group input').first().inputValue(), 'a[href="article.html?title=cats-1"]');
  assert.equal(await cards.nth(1).locator('.field', { hasText: 'If not found' }).locator('input').inputValue(), 'cats — result 1',
    'recorded the link text as a backup');
  ok('recorded textarea + Enter across a page navigation, and the result click');

  // ---- Replay it: Enter must submit the form and the click must find the link.
  await openSite('search.html');
  assert.match(await runAndWait(), /^Done/);
  await site.waitForURL(/article\.html\?title=cats-1/);
  assert.equal(await site.textContent('#title'), 'cats-1');
  ok('replay: Enter submitted the search, result link found on a fresh page load');

  // ---- Same search for each value of a data set, 2 runs.
  await cards.nth(1).locator('.switch input').setChecked(false);
  await cards.nth(0).locator('.source-select').selectOption('__new__');
  await panel.click('#tab-data');
  await panel.locator('.dataset').last().locator('textarea').fill('dogs\nbirds');
  assert.equal((await panel.textContent('#runBtn')).trim(), 'Run 2×', 'automatic: one run per value');
  await openSite('search.html');
  await site.evaluate(() => localStorage.clear());
  assert.match(await runAndWait(), /^Done/);
  await site.waitForURL(/results\.html\?q=birds/);
  assert.equal(await site.textContent('#history'), 'dogs, birds');
  ok('searched each data set value in turn:', await site.textContent('#history'));

  // ---- Record a suggestion that acts on mousedown and vanishes before "click".
  await newPlanNamed('Suggestions');
  await openSite('search.html');
  await panel.click('#emptyRecordBtn');
  await recorderReady();
  await site.click('textarea[name=q]');
  await site.keyboard.type('do');
  await site.waitForSelector('ul[role=listbox] li:has-text("dogs videos")');
  await Promise.all([site.waitForURL(/q=dogs\+videos/), site.click('ul[role=listbox] li:has-text("dogs videos")')]);
  await recorderReady();
  await stopRecording();
  assert.deepEqual(await titles(), ['Type text', 'Click'], 'mousedown-only suggestion was recorded');
  await openSite('search.html');
  assert.match(await runAndWait(), /^Done/);
  await site.waitForURL(/q=dogs\+videos/);
  assert.equal(await site.textContent('#heading'), 'Results for dogs videos');
  ok('recorded and replayed a mousedown-only suggestion');

  // ---- Enter on a field with no form, handled only by a keyCode === 13 check.
  await newPlanNamed('Quick search');
  await panel.click('#emptyAddBtn');
  await panel.click('#addMenu button:has-text("Type text")');
  await cards.nth(0).locator('.input-group input').first().fill('#quick');
  await cards.nth(0).locator('textarea').fill('hello');
  await cards.nth(0).locator('.check', { hasText: 'Press Enter' }).locator('input').check();
  await openSite('search.html');
  assert.match(await runAndWait(), /^Done/);
  assert.equal(await site.textContent('#quickOut'), 'Searched: hello');
  ok('Enter reached a keyCode-checking handler on a field with no form');

  // ---- Right-click (custom context menu) and double-click: record and replay.
  await newPlanNamed('Mouse buttons');
  await openSite('playground.html');
  await panel.click('#emptyRecordBtn');
  await recorderReady();
  await site.click('#ctxTarget', { button: 'right' });
  await site.click('#ctxRename');
  await site.dblclick('#ctxTarget');
  await site.waitForTimeout(200);
  await stopRecording();
  assert.equal(await site.textContent('#ctxOut'), 'renamed, double-clicked');
  const mouseSteps = await panel.locator('#blockList .summary').allTextContents();
  assert.deepEqual(mouseSteps, ['Right-click #ctxTarget', 'Click #ctxRename', 'Double-click #ctxTarget'],
    'the two clicks of a double-click fold into one step');
  await openSite('playground.html');
  assert.match(await runAndWait(), /^Done/);
  assert.equal(await site.textContent('#ctxOut'), 'renamed, double-clicked');
  ok('recorded and replayed right-click (context menu) and double-click:', mouseSteps);

  // ---- Scrolling: a section of the page (#notes) and the whole page are
  // recorded as separate steps; scrolls made by page scripts are not.
  await newPlanNamed('Scrolling');
  await openSite('playground.html');
  await panel.click('#emptyRecordBtn');
  await recorderReady();
  const notesBox = await site.locator('#notes').boundingBox();
  await site.mouse.move(notesBox.x + notesBox.width / 2, notesBox.y + notesBox.height / 2);
  await site.mouse.wheel(0, 200);
  await site.waitForTimeout(1000);
  await site.mouse.move(450, 20); // over the page itself, outside the section
  await site.mouse.wheel(0, 500);
  await site.waitForTimeout(1000);
  await site.evaluate(() => window.scrollBy(0, 300)); // a page script, not the user
  await site.waitForTimeout(1000);
  await site.mouse.wheel(0, -200);
  await site.waitForTimeout(1000); // the last scroll is sent once it rests
  const recordedNotes = await site.evaluate(() => document.getElementById('notes').scrollTop);
  await stopRecording();
  const scrollSteps = await panel.locator('#blockList .summary').allTextContents();
  assert.equal(scrollSteps.length, 2, `steps: ${scrollSteps.join(' | ')}`);
  assert.match(scrollSteps[0], /^Down \d+px in #notes$/, 'section scroll targets the section');
  // Down 500, then up 200: one page step of the net 300 px. The 300 px a page
  // script scrolled in between is not counted.
  assert.equal(scrollSteps[1], 'Down 300px on page', 'page scrolls are a separate page step, script scroll ignored');
  assert.equal(Number(scrollSteps[0].match(/\d+/)[0]), recordedNotes, 'section amount matches what the user scrolled');
  await openSite('playground.html');
  assert.match(await runAndWait(), /^Done/);
  await site.waitForTimeout(400);
  const replayed = await site.evaluate(() => ({ notes: document.getElementById('notes').scrollTop, page: Math.round(window.scrollY) }));
  assert.equal(replayed.notes, recordedNotes, 'replay scrolled the section by the same amount');
  assert.ok(Math.abs(replayed.page - 300) <= 2, `replay scrolled the page down 500 then up 200 (at ${replayed.page})`);
  ok('recorded section and whole-page scrolls separately and replayed them:', scrollSteps);

  // ---- Screenshot steps: whole page and a single element.
  await newPlanNamed('Screenshots');
  await panel.click('#emptyAddBtn');
  await panel.click('#addMenu button:has-text("Screenshot")');
  await panel.click('#addBtn');
  await panel.click('#addMenu button:has-text("Screenshot")');
  await cards.nth(1).locator('.input-group input').first().fill('#bump');
  await cards.nth(1).locator('.field', { hasText: 'File name' }).locator('input').fill('button-{{index}}');
  await panel.click('#logClear');
  await openSite('playground.html');
  assert.match(await runAndWait(), /^Done/);
  const shotItems = panel.locator('#logList .log-item.shot');
  assert.equal(await shotItems.count(), 2);
  assert.match(await shotItems.nth(0).textContent(), /screenshot-1\.png/);
  assert.match(await shotItems.nth(1).textContent(), /button-1\.png/);
  const sizes = await shotItems.locator('img').evaluateAll((imgs) => Promise.all(imgs.map((img) => img.decode().then(() => [img.naturalWidth, img.naturalHeight]))));
  const btn = await site.locator('#bump').boundingBox();
  // Headless windows capture at their real size, not the emulated viewport.
  assert.ok(sizes[0][0] >= 300 && sizes[0][0] > sizes[1][0] * 3, `page capture is the whole visible tab (${sizes[0]})`);
  assert.ok(Math.abs(sizes[1][0] - Math.round(btn.width)) <= 2 && Math.abs(sizes[1][1] - Math.round(btn.height)) <= 2,
    `element capture is cropped to the button (${sizes[1]} vs ${btn.width}×${btn.height})`);
  const download = panel.waitForEvent('download');
  await shotItems.nth(1).locator('button:has-text("Download")').click();
  assert.equal((await download).suggestedFilename(), 'button-1.png');
  await panel.screenshot({ path: join(out, 'panel-log.png') });
  ok('screenshots: page + element (cropped), shown in the log, downloadable:', sizes);


  // ================= Robustness & debugging upgrades =================
  const importPlan = async (planObj) => {
    const file = join(work, `${planObj.name.replace(/\W+/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(planObj));
    await panel.click('#planMenuBtn');
    const chooser = panel.waitForEvent('filechooser');
    await panel.click('[data-action="import"]');
    await (await chooser).setFiles(file);
    await panel.click('dialog button[type=submit]');
    await panel.waitForSelector('#blockList > li.block');
  };

  // ---- Retry: the slow button appears after 1.2 s; the step only waits 0.8 s.
  await importPlan({
    name: 'Retry',
    blocks: [
      { type: 'click', selector: '#showLate' },
      { type: 'click', selector: '#lateBtn' },
    ],
    retries: 0, stepDelay: 0, timeout: 800,
  });
  await openSite('playground.html');
  assert.match(await runAndWait(), /^Finished: 0 ok, 1 failed/, 'without retries the slow button times out');
  await panel.click('#tab-settings');
  await panel.selectOption('#retries', '1');
  await panel.click('#tab-steps');
  await panel.click('#logClear');
  await openSite('playground.html');
  assert.match(await runAndWait(), /^Done/, 'one retry (waiting 1.6 s) finds it');
  assert.equal(await site.textContent('#lateOut'), '1');
  assert.equal(await panel.locator('#logList .log-item.retry').count(), 1, 'the retry is shown in the log');
  ok('retry with a doubled timeout recovered a slow element');

  // ---- Find-by-text backup when the selector no longer matches.
  await importPlan({
    name: 'Text backup',
    blocks: [{ type: 'click', selector: 'div.old-layout > a.Xy12ab', fallbackText: 'cats — result 2' }],
    retries: 0, timeout: 1000,
  });
  await openSite('results.html?q=cats');
  assert.match(await runAndWait(), /^Done/);
  await site.waitForURL(/article\.html\?title=cats-2/);
  ok('a stale selector fell back to the element with the recorded text');

  // ---- Test a single step, and Find what a selector matches.
  await importPlan({
    name: 'Debug tools',
    blocks: [
      { type: 'click', selector: '#bump' },
      { type: 'click', selector: '#doesNotExist' },
    ],
    timeout: 500,
  });
  await openSite('playground.html');
  const countBefore2 = Number(await site.textContent('#counter'));
  await cards.nth(0).hover();
  await cards.nth(0).locator('[aria-label="Test this step"]').click();
  await waitUntil(panel, () => /^Done/.test(document.getElementById('runStatus').textContent), 10000);
  assert.equal(Number(await site.textContent('#counter')), countBefore2 + 1, 'only that step ran, once');
  assert.match(await panel.locator('#logList .log-sep').last().textContent(), /Finished · 1\/1/);
  assert.match(await panel.locator('#logList .log-sep').nth(-2).textContent(), /Testing step 1 · Click/);
  await panel.evaluate(() => document.getElementById('toasts').replaceChildren());
  await cards.nth(0).locator('.find-btn').click(); // imported steps start expanded
  await panel.waitForSelector('.toast');
  assert.equal(await panel.textContent('.toast'), '1 match.');
  ok('▶ Test this step ran one step; Find reported the match count');

  // ---- Undo a deleted step.
  await cards.nth(1).hover();
  await cards.nth(1).locator('.icon-btn.danger').click();
  await cards.nth(1).locator('.icon-btn.danger').click();
  assert.equal(await cards.count(), 1);
  await panel.click('.toast-action:has-text("Undo")');
  assert.equal(await cards.count(), 2);
  assert.match(await cards.nth(1).locator('.summary').textContent(), /#doesNotExist/);
  ok('Undo restored a deleted step in place');

  // ---- Speed: 10 clicks × 3 runs with no configured delays must be quick.
  {
    const perfFile = join(work, 'perf.json');
    writeFileSync(perfFile, JSON.stringify({
      name: 'Perf',
      blocks: Array.from({ length: 10 }, () => ({ type: 'click', selector: '#bump' })),
      timeout: 2000, runs: 3, runsMode: 'fixed', stepDelay: 0, runDelay: 0,
    }));
    await panel.click('#planMenuBtn');
    const perfChooser = panel.waitForEvent('filechooser');
    await panel.click('[data-action="import"]');
    await (await perfChooser).setFiles(perfFile);
    await panel.click('dialog button[type=submit]');
    await openSite('playground.html');
    const before = Number(await site.textContent('#counter'));
    const t0 = Date.now();
    assert.match(await runAndWait(), /^Done/);
    const elapsed = Date.now() - t0;
    assert.equal(Number(await site.textContent('#counter')) - before, 30, 'all 30 clicks happened');
    console.log(`  ⏱ 30 click steps took ${elapsed} ms (${Math.round(elapsed / 30)} ms/step)`);
    assert.ok(elapsed < PERF_BUDGET_MS, `30 steps should take < ${PERF_BUDGET_MS} ms, took ${elapsed} ms`);
    ok('speed budget met');
  }

  // ================= Timeout setting, Stop, Pause, slow pages, log size =================

  // ---- One shared element timeout, in Settings (not on every step).
  await importPlan({ name: 'Shared timeout', timeout: 1500, blocks: [{ type: 'wait', mode: 'appear', selector: '#pauseTarget', timeout: 99999 }] });
  assert.equal(await cards.nth(0).locator('label', { hasText: /up to|give up/i }).count(), 0, 'steps have no timeout field');
  await panel.click('#tab-settings');
  assert.equal(await panel.inputValue('#timeout'), '1500');
  await panel.click('#tab-steps');
  ok('element timeout is one plan setting');

  // ---- Pause freezes the current step, clock included; Resume continues it.
  await openSite('playground.html');
  await panel.click('#logClear');
  await panel.click('#runBtn');
  await panel.waitForTimeout(400);
  await panel.click('#pauseBtn');
  await panel.waitForTimeout(2200); // longer than the 1.5 s timeout
  assert.equal(await panel.textContent('#runStatus'), 'Paused');
  assert.deepEqual(await panel.locator('#logList .log-item').allTextContents(), [], 'nothing failed while paused');
  await site.evaluate(() => { const d = document.createElement('div'); d.id = 'pauseTarget'; d.textContent = 'here'; document.body.append(d); });
  await panel.waitForTimeout(500);
  assert.equal(await panel.textContent('#runStatus'), 'Paused', 'still paused even though the element appeared');
  await panel.click('#pauseBtn');
  assert.match(await (async () => { await waitUntil(panel, () => /^(Done|Finished|Stopped)/.test(document.getElementById('runStatus').textContent)); return panel.textContent('#runStatus'); })(), /^Done/);
  const pausedMs = await panel.locator('#logList .log-item.ok .log-ms').first().textContent();
  assert.ok(!/ s$/.test(pausedMs) || parseFloat(pausedMs) < 1.5, `paused time isn't counted (${pausedMs})`);
  ok('pause froze the step and its timeout; resume finished it:', pausedMs);

  // ---- Stop ends a run at once, mid-step (it used to wait for the step).
  await importPlan({ name: 'Stop', timeout: 30000, blocks: [{ type: 'wait', mode: 'appear', selector: '#never' }, { type: 'click', selector: '#bump' }] });
  await openSite('playground.html');
  const countBeforeStop = Number(await site.textContent('#counter'));
  await panel.click('#runBtn');
  await waitUntil(panel, () => /^Run 1\/1 · Step 1/.test(document.getElementById('runStatus').textContent));
  await panel.waitForTimeout(600); // well into the 30 s element wait
  let t0 = Date.now();
  await panel.click('#stopBtn');
  await waitUntil(panel, () => /^Stopped/.test(document.getElementById('runStatus').textContent), 5000);
  const stopMs = Date.now() - t0;
  assert.ok(stopMs < 1000, `stop took ${stopMs} ms`);
  assert.equal(await panel.isHidden('#stopBtn'), true);
  await panel.waitForTimeout(800);
  assert.equal(Number(await site.textContent('#counter')), countBeforeStop, 'no step ran after Stop');
  ok(`stop ended the run in ${stopMs} ms`);

  // ---- A page whose "load" is slow (held image) doesn't hold up the next step.
  await importPlan({ name: 'Slow page', timeout: 5000, stepDelay: 0, blocks: [{ type: 'click', selector: '#again' }, { type: 'click', selector: '#bump' }] });
  await site.goto(`${base}/slow.html`, { waitUntil: 'domcontentloaded' });
  await site.bringToFront();
  await waitUntil(panel, () => !document.getElementById('siteChip').hidden, 5000);
  await panel.click('#logClear');
  t0 = Date.now();
  assert.match(await runAndWait(), /^Done/);
  const slowMs = Date.now() - t0;
  assert.equal(await site.textContent('#count'), '1', 'clicked on the new page');
  assert.match(site.url(), /n=2/);
  assert.ok(slowMs < 4000, `didn't wait for the 10 s image (took ${slowMs} ms)`);
  ok(`next step ran ${slowMs} ms after a page whose load takes 10 s`);

  // ---- The log is docked under the steps: dragging its divider (or header)
  // up grows it and shortens the steps area by the same amount.
  {
    const box = (sel) => panel.locator(sel).boundingBox();
    const drag = async (sel, dy) => {
      const b = await box(sel);
      const x = b.x + b.width / 3;
      const y = b.y + Math.min(5, b.height / 2);
      await panel.mouse.move(x, y);
      await panel.mouse.down();
      await panel.mouse.move(x, y + dy, { steps: 6 });
      await panel.mouse.up();
    };
    const before = await box('#logPanel');
    const mainBefore = await box('main');
    assert.ok(Math.abs(mainBefore.y + mainBefore.height - before.y) < 2, 'steps area ends where the log begins');
    await drag('#logResize', -150);
    const after = await box('#logPanel');
    const mainAfter = await box('main');
    assert.ok(Math.abs(after.height - before.height - 150) < 4, `log grew by 150 px (${before.height} → ${after.height})`);
    assert.ok(Math.abs(mainBefore.height - mainAfter.height - 150) < 4, `steps area shrank by 150 px (${mainBefore.height} → ${mainAfter.height})`);
    assert.ok(Math.abs(mainAfter.y + mainAfter.height - after.y) < 2, 'still touching after the drag');
    await panel.screenshot({ path: join(out, 'panel-log-docked.png') });
    assert.equal(await panel.evaluate(() => localStorage.getItem('clickflow.logHeight')), String(Math.round(after.height)), 'height remembered');
    await drag('.log-head strong', 80);
    assert.ok(Math.abs((await box('#logPanel')).height - (after.height - 80)) < 4, 'dragging the header works too');
    await panel.focus('#logResize');
    await panel.keyboard.press('ArrowUp');
    assert.ok(Math.abs((await box('#logPanel')).height - (after.height - 80 + 24)) < 4, 'keyboard resizes it');
    await panel.dblclick('#logResize');
    assert.equal(Math.round((await box('#logPanel')).height), Math.round(before.height), 'double-click resets');
    ok('log docked under the steps: divider/header drag and keyboard resize both, remembered, double-click resets');
  }

  // ---- Restricted pages are refused. Without the "tabs" permission Chrome
  // hides chrome:// URLs, so the panel reports "restricted" or "can't see".
  await site.goto('chrome://version');
  await waitUntil(panel, () => !document.getElementById('siteBanner').hidden);
  await panel.evaluate(() => document.getElementById('toasts').replaceChildren());
  await panel.click('#runBtn');
  await panel.waitForSelector('.toast.error');
  assert.match(await panel.textContent('.toast.error'), /access|can't run/i);
  assert.equal(await panel.isVisible('#stopBtn'), false, 'run must not start');
  ok('restricted page refused:', await panel.textContent('.toast.error'));

  // ---- Compose 1280×800 Chrome Web Store screenshots: page left, panel right.
  const img = (f) => `data:image/png;base64,${readFileSync(join(out, f)).toString('base64')}`;
  const shots = [
    ['store/screenshot-1-record.png', 'site-recording.png', 'panel-recording.png'],
    ['store/screenshot-2-run.png', 'playground-after.png', 'panel-done.png'],
    ['store/screenshot-3-picker.png', 'picker.png', 'panel-data.png'],
  ];
  const composer = await context.newPage();
  await composer.setViewportSize({ width: 1280, height: 800 });
  for (const [dest, left, right] of shots) {
    await composer.setContent(`<body style="margin:0;display:flex;background:#e9ebf3;height:800px;overflow:hidden">
      <img src="${img(left)}" style="width:900px;height:800px;object-fit:cover;object-position:top left">
      <img src="${img(right)}" style="width:380px;height:800px;object-fit:cover;object-position:top;border-left:1px solid #cfd4e2">
    </body>`);
    await composer.screenshot({ path: join(root, dest) });
  }
  ok('store screenshots written to store/');

  console.log('\nAll e2e checks passed. Screenshots in test-results/');
} catch (e) {
  failed = true;
  console.error('✗ E2E failure:', e);
  for (const [i, p] of context.pages().entries()) await p.screenshot({ path: join(out, `failure-${i}.png`) }).catch(() => {});
} finally {
  await context.close();
  for (const res of held) res.end();
  server.close();
  process.exitCode = failed ? 1 : 0;
}
