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
manifest.host_permissions = ['http://127.0.0.1/*'];
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

// Serves only the known test pages (no path traversal).
const PAGES = new Set(['playground.html', 'search.html', 'results.html', 'article.html']);
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
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
  await cards.nth(1).locator('.block-title').click();
  assert.equal(await cards.nth(1).locator('.source-select').inputValue(), '__fixed__');
  await cards.nth(1).locator('.source-select').selectOption('__new__');
  await cards.nth(2).locator('.block-title').click();
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

  // ---- Settings: number of runs.
  await panel.click('#tab-settings');
  assert.equal(await panel.textContent('#matchLongestBtn'), 'Match the longest data set (3 runs)');
  await panel.click('#quickRuns button[data-runs="10"]');
  assert.equal(await panel.inputValue('#runs'), '10');
  await panel.click('#matchLongestBtn');
  assert.equal(await panel.inputValue('#runs'), '3');
  assert.equal((await panel.textContent('#runBtn')).trim(), 'Run 3×');
  await panel.fill('#stepDelay', '50');
  await panel.locator('#stepDelay').dispatchEvent('change');
  await panel.fill('#runDelay', '100');
  await panel.locator('#runDelay').dispatchEvent('change');
  await panel.screenshot({ path: join(out, 'panel-settings.png') });
  ok('runs set from quick buttons and "match longest"');
  await panel.click('#tab-steps');

  // ---- Run 3 times: each text box takes the next value from its own list;
  // the shorter email list starts over.
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
  await cards.last().locator('.block-title').click();
  await cards.last().locator('.input-group input').fill('#does-not-exist');
  await cards.last().locator('.field', { hasText: 'Wait for element' }).locator('input').fill('300');
  await cards.last().locator('.field', { hasText: 'Wait for element' }).locator('input').dispatchEvent('change');
  await panel.click('#tab-settings');
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
  await cards.nth(0).locator('.block-title').click();
  assert.equal(await cards.nth(0).locator('.input-group input').first().inputValue(), 'textarea[name="q"]');
  assert.equal(await cards.nth(0).locator('textarea').inputValue(), 'cats');
  assert.equal(await cards.nth(0).locator('.check', { hasText: 'Press Enter' }).locator('input').isChecked(), true,
    'Enter in a textarea search box was recorded');
  await cards.nth(1).locator('.block-title').click();
  assert.equal(await cards.nth(1).locator('.input-group input').first().inputValue(), 'a[href="article.html?title=cats-1"]');
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
  await panel.click('#tab-settings');
  await panel.click('#matchLongestBtn');
  assert.equal(await panel.inputValue('#runs'), '2');
  await panel.click('#tab-steps');
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
  server.close();
  process.exitCode = failed ? 1 : 0;
}
