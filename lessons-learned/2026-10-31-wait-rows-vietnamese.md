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
