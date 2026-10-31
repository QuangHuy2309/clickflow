# 2026-10-31: Initial build and first UI rounds

Bugs found by the e2e test while building v1.0 through the data-sets redesign.

## `hidden` elements still showed

- **Symptom:** Pause/Stop buttons and an empty warning banner were visible while idle. Later the on-page "running" badge never disappeared.
- **Root cause:** a class rule such as `.btn { display: inline-flex }` beats the browser's `[hidden] { display: none }`. It happened twice: once in the panel CSS and once in a shadow-root stylesheet.
- **Fix:** `[hidden] { display: none !important; }` in `panel.css` and in every shadow-root style block (`actions.js`).
- **Guard:** the e2e test checks visibility of run controls and the badge, and screenshots are reviewed each round.

## "Add step" menu clipped on an empty plan

- **Symptom:** the menu opened upward and was cut off by the scroll container.
- **Fix:** it now opens downward, followed by `scrollIntoView({ block: 'nearest' })`.

## Test tooling vs the extension's CSP

- **Symptom:** Playwright's `waitForFunction` failed on extension pages ("Refused to evaluate a string as JavaScript").
- **Root cause:** the MV3 CSP forbids `eval`. That's good, but `waitForFunction` relies on it.
- **Fix:** `waitUntil(page, fn)` polls with `page.evaluate()` instead.

## Native drag-and-drop can't be driven in extension-created windows

- **Symptom:** `dragstart` was immediately followed by `dragend` in the popup window the test opens with `chrome.windows.create`.
- **Root cause:** Playwright doesn't intercept drags in windows that the extension creates. It works fine in normal tabs.
- **Fix:** the drag test opens the panel page in a regular tab. The handle-only drag source is set once on the card header instead of being toggled on pointerdown.

## Picker reply arrived before the panel was listening

- **Symptom:** a fast pick was ignored.
- **Root cause:** `state.pick` was set after the `executeScript` call that activates the picker had resolved, so the page could reply first.
- **Fix:** register the pick request before injecting the picker, and roll it back if injection fails.

## Picking `<html>` or `<body>` produced an empty selector

- **Fix:** `selector.js` returns `html`/`body` for those elements, and the panel rejects empty selectors.

## Lazy-loading list search gave up too early

- **Symptom:** "Find in list" failed around item 170 of 300.
- **Fix:** the default max scrolls went from 50 to 300, and each scroll step is 90% of the visible height.

## Wide data table in a narrow side panel

- **Root cause:** inputs have a ~150 px intrinsic width that widens table columns.
- **Fix:** `size=1` on cell inputs. (The table was later replaced by data sets.)

## Windows shell pitfalls (tooling)

- PowerShell 5.1 `Get-Content`/`Set-Content` re-encode UTF-8 as ANSI and garble characters like `→` and `—`. Use Node or `[IO.File]` with UTF-8 (no BOM) for edits.
- Double quotes inside a here-string passed to `git commit -m` get split into separate arguments. Use `git commit -F <file>`.
- Long `node -e` one-liners with mixed quotes break in Git Bash. Put scripts in `.playwright/scratch/` and run them.
