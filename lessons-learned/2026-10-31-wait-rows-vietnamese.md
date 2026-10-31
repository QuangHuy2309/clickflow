# 2026-10-31: Then wait, For each row, Vietnamese (v1.3.0)

Requested by the user:
- a timer on each step (a number plus seconds or minutes, under an hour);
- a Vietnamese version with a language switch;
- a step that clicks the name link in every row of a list whose cell passes a rule, or whose checkbox is ticked, and then moves on to the next row.

The user chose: links open in background tabs, a cell rule plus optionally only ticked rows, and one click per row.

Regression tests:
- unit: "Then wait … under an hour", "For each row: the cell is required only when there is a rule", and `test/i18n.test.js` (every string translated, placeholders kept, no stale entries);
- e2e: "then wait", the four "for each row" checks on `test/rows.html` (a lazy-loading list), and "language".

## New tabs failed: "Tab opener must be in the same window"

- **Symptom:** the first "For each row" run failed on every row with "Tab opener must be in the same window as the updated tab."
- **Root cause:** `chrome.tabs.create` with `openerTabId` defaults to the *current* window. That's the side panel's window, not always the list tab's window (in the e2e test it never is).
- **Fix (`runner.js`):** pass `windowId: tab.windowId` of the list tab.
- **Guard:** e2e "for each row: opened only rows with score > 0…".

## A retry would have opened rows twice

- **Symptom:** the failing run above was retried. After some rows were already handled, a retry would start a new job and open the same rows again.
- **Fix (`runner.js`):** a row step that fails after handling rows returns `noRetry`, and the retry loop respects it.
- **Lesson:** retries are only safe for steps that have no side effects yet. Ask "what did the first attempt already do?" before retrying.

## Background tabs stay about:blank in Playwright

- **Symptom:** the test saw the new tabs, but their URL was `about:blank`.
- **Root cause:** headless Chromium may not load background tabs.
- **Fix (test):** read `pendingUrl || url` from `chrome.tabs.query` in the extension's service worker, and close the tabs the same way.

## "Then wait" row overflowed the card

- **Symptom:** the number box took the full width and pushed the seconds/minutes dropdown out of the card (seen in the regenerated store screenshot).
- **Root cause:** `.field input[type="number"] { width: 100% }` (specificity 0,2,1) beat `.wait-after .wait-amount` (0,2,0).
- **Fix (`panel.css`):** `.wait-after .input-group .wait-amount` / `.wait-unit`.
- **Guard:** e2e checks that the dropdown's right edge is inside the step card.
- **Lesson:** look at the screenshots a test run produces. They catch layout bugs that assertions don't.

## Translating without restructuring

- **Decision:** the English text is the key (`t('Run {n}×', { n })`), and `src/shared/i18n-vi.js` maps it to Vietnamese, falling back to English. The schema, block labels and HTML stayed in English, and are translated where they're shown.
  - Static HTML text is captured once, before anything is rendered into it, and rewritten on language change (`captureStatic` / `translateStatic`).
  - Page-side errors come back as `{ key, vars }` and are translated in the panel.
  - The picker and recorder bars get their text from the panel.
- **Guard:** `test/i18n-keys.mjs` collects every key from the source (t() calls including ternaries, `StepError`, `message =`, `.note =`, schema, HTML), and `i18n.test.js` fails on a missing or stale translation, or a translation that drops a `{placeholder}`.
- **Lesson:** a status check like `/^Recording/.test(text)` breaks once the text is translated. Keep state in state (a class here), not in displayed text.

## Timing tests under heavy load

- **Symptom:** while a game was using the CPU, a different timing check failed on each run (Stop 1.1 s, Pause, speed 115 ms/step).
- **What settled it:** the base branch's e2e, run in a temporary worktree under the same load, passed (52 ms/step, Stop 23 ms). Timestamps in the panel then showed that Stop itself took under 1 ms from the click handler to the end of the run. The delay came before the handler: the click itself was slow to arrive. Once the load dropped, the branch measured 48 ms/step and Stop in 20 ms.
- **Lesson:** compare against a baseline under the same conditions before blaming, or excusing, a change.

## Shell quoting on Windows (again)

- `\b` inside `node -e "…"` through bash became a backspace character (0x08) in a test regex, and `\\s` lost its backslash in a heredoc. For anything with regexes or quotes, write the edit script with the Write tool and run it, or use Edit directly (rule from the initial build).

## Follow-up: "For each row" was too complex; moving steps

- **Feedback:** the first version (one target per row, plus checkbox, new-tab, gap and row options) was too complex. The user wanted "if the row matches, do all the steps inside it", and an easier way to move steps: one up or down, or dragged past several.
- **Change:**
  - **For each row is now a container (`steps`, one level deep):** you pick one row, then a rule (every row, ticked rows, or a cell rule), then add steps inside. Inner steps carry the loop's token. While one runs, `query()` searches only the current row: a selector picked in any row is mapped by its position inside that row (`inRow`), found once and cached.
  - **Links:** a left click on a web link inside a row opens a background tab, so the list stays.
  - **Finding the row:** the row is the ancestor of the picked element with the most siblings like it, so picking a link or cell inside a row works too.
  - **Moving:** dragging now uses pointer events instead of HTML5 drag and drop. It auto-scrolls the list, drops into and out of a loop, Esc cancels it, and a press without movement still counts as a click. At a loop's edge, ↑/↓ move a step out of the loop.
- **Bug found by a screenshot:** when a step inside a loop failed, every step in that loop got a red border. `.block.is-error .step-card` also matched nested cards. **Fix:** child combinators (`.block.is-error > .step-card`, `> .rail .step-no`) for every state class. **Guard:** e2e compares the computed border colors of the failing and passing inner steps.
- **Test lessons:**
  - `button:has-text("Scroll")` matched "Select / find in list", whose description mentions scrolling. Match the exact title (`:has(strong:text-is(…))`).
  - A drop point within 48 px of the list's edge triggers auto-scroll, which made a drag test flaky. Keep test drops away from the edges.
- **Guard:** e2e "move steps…" (drag past two steps, into and out of a loop, ↑/↓ out of a loop, Esc) and five "for each row" checks (two steps per row, ticked rows, a limit with the row picked by an inner element, "1,250" read as 1250, a failing inner step). Unit tests cover nested sanitizing (one level deep, at most 50 per loop, the plan limit counts nested steps, fresh ids) and data sets used inside loops.

## Store assets: the promo tile had an alpha channel

- **Found while preparing the listing:** the Web Store requires promo images and screenshots to be JPEG or 24-bit PNG without alpha. `store/promo-small-440x280.png` was RGBA.
- **Fix (`scripts/make-icons.mjs`):** `png(..., { alpha: false })` writes RGB, and the icon's soft edges are blended into the background first. The 128 px icon keeps its alpha, which is allowed for icons.
- **Also:** store screenshots 4 (For each row) and 5 (Vietnamese) are generated by the e2e run, with stale toasts cleared before capture.

## The store zip was a tar archive

- **Symptom:** the dashboard rejected `dist/clickflow-1.3.0.zip`: "Invalid package: make sure manifest.json is at the root of the zip". The file was exactly 409,600 bytes, a multiple of tar's block size.
- **Root cause:** `scripts/package.ps1` ran `tar -a … x.zip`, expecting Windows' bsdtar. When PowerShell is started from Git Bash, `C:\Program Files\Git\usr\bin\tar.exe` (GNU tar) comes first on PATH. GNU tar ignores the `.zip` extension and writes a tar archive. `tar -t` still listed the files, so the earlier check passed.
- **Fix:** call `$env:SystemRoot\System32\tar.exe` by full path, and fail unless the file starts with the zip signature `PK`.
- **Lesson:** check the file format itself (its first bytes), not just that a tool can read it back.
