// End-to-end smoke test: loads the extension in Chromium, builds a plan through
// the real side panel UI, runs it against test/playground.html, and saves
// screenshots to test-results/. Run: npm run e2e
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

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(readFileSync(join(root, 'test', 'playground.html')));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/playground.html`;

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

let failed = false;
try {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  for (let i = 0; i < 50 && !(await sw.evaluate(() => Boolean(globalThis.chrome?.windows))); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // Drag-and-drop check in a regular tab: Playwright can't drive native drags
  // in windows created by an extension.
  {
    const tab = await context.newPage();
    await tab.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
    await tab.waitForSelector('#runBtn svg');
    for (const label of ['Click', 'Wait']) {
      await tab.click('#addBtn');
      await tab.click(`#addMenu button:has-text("${label}")`);
    }
    const tabCards = tab.locator('#blockList > li');
    await tabCards.last().locator('.grip').dragTo(tabCards.first(), { targetPosition: { x: 60, y: 4 } });
    assert.equal(await tabCards.first().locator('.block-title strong').textContent(), 'Wait', 'drag moved Wait to top');
    console.log('✓ drag-and-drop reorder');
    for (let i = 0; i < 2; i++) {
      await tabCards.first().hover();
      await tabCards.first().locator('.icon-btn.danger').click();
      await tabCards.first().locator('.icon-btn.danger').click();
    }
    await tab.waitForTimeout(400);
    await tab.close();
  }

  const site = context.pages()[0] || await context.newPage();
  await site.goto(pageUrl);
  await site.bringToFront();

  // Open the panel in its own unfocused window so the playground stays the active tab.
  const panelPromise = context.waitForEvent('page');
  await sw.evaluate((url) => chrome.windows.create({ url, type: 'popup', focused: false, width: 400, height: 860 }),
    `chrome-extension://${extId}/src/sidepanel/index.html`);
  const panel = await panelPromise;
  await panel.setViewportSize({ width: 380, height: 860 });
  await panel.waitForSelector('#runBtn svg');
  await site.bringToFront();
  await waitUntil(panel, () => !document.getElementById('siteChip').hidden, 5000);
  console.log('✓ panel sees playground with site access:', await panel.textContent('#siteChip'));

  const addStep = async (label) => {
    await panel.click('#addBtn');
    await panel.click(`#addMenu button:has-text("${label}")`);
  };
  const lastCard = () => panel.locator('#blockList > li').last();
  const fill = (label, value) => lastCard().locator('.field', { hasText: label }).locator('input, textarea, select').first().fill(value);

  await addStep('Click');
  await fill('Element', '#bump');
  await addStep('Type text');
  await fill('Input field', '#name');
  await addStep('Select / find in list');
  await fill('Dropdown or scrollable list', '#country');
  await fill('Value to find', 'Japan');
  await addStep('Select / find in list');
  await fill('Dropdown or scrollable list', '#cityList');
  await fill('Click this first', '#cityBtn');
  await fill('Value to find', '{{value}}');
  await addStep('Click');
  await fill('Element', '#submit');
  await addStep('Wait');

  const cards = panel.locator('#blockList > li');
  await cards.last().hover();
  await cards.last().locator('.icon-btn.danger').click();
  await cards.last().locator('.icon-btn.danger').click();
  assert.equal(await cards.count(), 5);
  console.log('✓ delete with inline confirm');

  // Move "Type text" below the first Click with the arrow buttons, check order.
  await cards.nth(1).hover();
  await cards.nth(1).locator('[aria-label="Move up"]').click();
  assert.equal(await cards.first().locator('.block-title strong').textContent(), 'Type text');
  await cards.first().hover();
  await cards.first().locator('[aria-label="Move down"]').click();
  const titles = await panel.locator('#blockList .block-title strong').allTextContents();
  assert.deepEqual(titles, ['Click', 'Type text', 'Select / find in list', 'Select / find in list', 'Click']);
  console.log('✓ move up/down');

  await panel.fill('#dataInput', 'alice, bob, Tokyo');
  assert.equal(await panel.textContent('#runCount'), '3 runs');
  await panel.click('summary');
  await panel.fill('#stepDelay', '50');
  await panel.locator('#stepDelay').dispatchEvent('change');
  await panel.fill('#runDelay', '100');
  await panel.locator('#runDelay').dispatchEvent('change');
  await panel.screenshot({ path: join(out, 'panel-plan.png') });

  await panel.click('#runBtn');
  await site.waitForFunction(() => document.querySelectorAll('#log li').length === 3, null, { timeout: 60000 });
  const log = await site.locator('#log li').allTextContents();
  assert.deepEqual(log, [
    'name=alice country=jp city=alice',
    'name=bob country=jp city=bob',
    'name=Tokyo country=jp city=Tokyo',
  ]);
  assert.equal(await site.textContent('#counter'), '3');
  await waitUntil(panel, () => document.getElementById('runStatus').textContent.startsWith('Done'));
  console.log('✓ 3 data-driven runs completed:', log);
  await panel.screenshot({ path: join(out, 'panel-done.png') });
  await site.screenshot({ path: join(out, 'playground-after.png') });

  // A missing element should fail with a readable error on the right block.
  await cards.last().locator('.input-group input').fill('#does-not-exist');
  await cards.last().locator('.field', { hasText: 'Wait for element' }).locator('input').fill('300');
  await cards.last().locator('.field', { hasText: 'Wait for element' }).locator('input').dispatchEvent('change');
  await panel.fill('#dataInput', 'x');
  await panel.click('#runBtn');
  await panel.waitForSelector('.block.is-error .block-error');
  console.log('✓ error surfaced on block:', await panel.textContent('.block-error'));
  await panel.screenshot({ path: join(out, 'panel-error.png') });

  // Element picker: hover + click a page element fills the selector.
  const countBefore = await site.textContent('#counter');
  await addStep('Click');
  await lastCard().locator('.pick-btn').click();
  await site.waitForSelector('clickflow-picker', { state: 'attached' });
  await site.mouse.move(10, 10);
  const box = await site.locator('#bump').boundingBox();
  await site.mouse.move(box.x + 5, box.y + 5);
  await site.screenshot({ path: join(out, 'picker.png') });
  await site.mouse.click(box.x + 5, box.y + 5);
  await waitUntil(panel, () => {
    const inputs = document.querySelectorAll('#blockList > li:last-child .input-group input');
    return inputs[0]?.value === '#bump';
  });
  assert.equal(await site.textContent('#counter'), countBefore, 'picker click must not reach the page');
  console.log('✓ element picker filled "#bump" without triggering the page');

  // Hostile import is sanitized and rendered as text.
  const evil = join(work, 'evil.json');
  writeFileSync(evil, JSON.stringify({ name: '<img src=x onerror="document.title=\'pwned\'">', blocks: [{ type: 'click', selector: '<script>x</script>' }, { type: 'eval', code: 'alert(1)' }] }));
  await panel.click('#planMenuBtn');
  const chooser = panel.waitForEvent('filechooser');
  await panel.click('[data-action="import"]');
  await (await chooser).setFiles(evil);
  await panel.waitForSelector('dialog[open]');
  const dialogText = await panel.textContent('dialog');
  assert.match(dialogText, /1 unsupported step/);
  await panel.click('dialog button[type=submit]');
  assert.equal(await panel.evaluate(() => document.querySelectorAll('img[src="x"]').length), 0);
  assert.notEqual(await panel.title(), 'pwned');
  console.log('✓ hostile import sanitized, no markup injected');

  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.screenshot({ path: join(out, 'panel-dark.png') });

  // Restricted pages are refused.
  await site.goto('chrome://version');
  // Without the "tabs" permission Chrome hides chrome:// URLs, so the panel
  // reports either "restricted" or "can't see this tab"; both must refuse.
  await waitUntil(panel, () => !document.getElementById('siteBanner').hidden);
  await panel.evaluate(() => document.getElementById('toasts').replaceChildren());
  await panel.click('#runBtn');
  await panel.waitForSelector('.toast.error');
  assert.match(await panel.textContent('.toast.error'), /access|can't run/i);
  assert.equal(await panel.isVisible('#stopBtn'), false, 'run must not start');
  console.log('✓ restricted page refused:', await panel.textContent('.toast.error'));

  // Compose 1280×800 Chrome Web Store screenshots: page on the left, panel on the right.
  const img = (f) => `data:image/png;base64,${readFileSync(join(out, f)).toString('base64')}`;
  const shots = [
    ['store/screenshot-1-plan.png', 'playground-after.png', 'panel-done.png'],
    ['store/screenshot-2-picker.png', 'picker.png', 'panel-plan.png'],
  ];
  const composer = await context.newPage();
  await composer.setViewportSize({ width: 1280, height: 800 });
  for (const [dest, left, right] of shots) {
    await composer.setContent(`<body style="margin:0;display:flex;background:#e9ebf3;height:800px;overflow:hidden">
      <img src="${img(left)}" style="width:900px;height:800px;object-fit:cover;object-position:top left">
      <img src="${img(right)}" style="width:380px;height:800px;object-fit:cover;object-position:bottom;border-left:1px solid #cfd4e2">
    </body>`);
    await composer.screenshot({ path: join(root, dest) });
  }
  console.log('✓ store screenshots written to store/');

  console.log('\nAll e2e checks passed. Screenshots in test-results/');
} catch (e) {
  failed = true;
  console.error('✗ E2E failure:', e);
  for (const p of context.pages()) await p.screenshot({ path: join(out, `failure-${context.pages().indexOf(p)}.png`) }).catch(() => {});
} finally {
  await context.close();
  server.close();
  process.exitCode = failed ? 1 : 0;
}
