# 2026-10-31: Speed, run count, right-click, screenshots, log and upgrades

Requested by the user:
- runs are slower than expected (verify with tests)
- count runs from the data sets, using the shortest
- right-click
- screenshots
- an on-screen log
- research and apply upgrades

Regression tests are in `test/e2e.mjs`: speed budget, automatic runs, mouse buttons, screenshots, the log, retry, text backup, test step / Find / Undo.

## Runs were slow: about 160 ms of overhead per step, before any configured delay

- **Measured:** a new e2e test imports a plan of 10 clicks × 3 runs with all delays set to 0 and times it. Before: 4.8 s, about 160 ms per step. After: 1.46 s, about 49 ms per step.
- **Root causes:**
  - two `chrome.scripting.executeScript` calls per step (inject the file, then call it)
  - a fixed 150 ms sleep after every step to detect navigation
  - generous default delays (300 ms between steps, 1 s between runs)
- **Fix (`runner.js`):**
  - one call per step; the file is injected only when the page doesn't have it yet
  - navigation detected from `chrome.tabs.onUpdated` "loading" events, with a 40 ms grace period, and only for steps that can navigate
  - if a step hits a page that is still tearing down, wait for the load and retry once
  - new-plan defaults lowered to 100 ms / 300 ms
  - element waits use `MutationObserver` instead of 100 ms polling
- **Guard:** the e2e speed budget (`PERF_BUDGET_MS`, 3000 ms for 30 steps). Raise it only with a reason.

## Run count must follow the data

- **Change:** `runsMode` is now `auto` (the default): one run per value of the **shortest** data set used by enabled steps, or 1 run if no step uses a set. `fixed` keeps the manual number and the "when a set runs out" option. Logic is in `runCount()` in `src/shared/data.js`.
- **Guard:** unit test "runCount: automatic mode…" and the e2e Settings check.

## Click steps clicked elements that were still hidden

- **Symptom:** found while testing retries. A hidden `#lateBtn` was clicked immediately, because waits only checked that the element existed.
- **Root cause:** `waitFor` didn't require visibility for Click and Type steps.
- **Fix:** Click and Type steps wait for a visible element. The error message says when the element exists but stays hidden.
- **Guard:** e2e "retry with a doubled timeout recovered a slow element". It fails with retries = 0, which proves the wait respects visibility.

## Screenshots need all-sites access

- **Symptom:** `captureVisibleTab` failed with only per-site host permission.
- **Root cause:** Chrome requires `<all_urls>` or a fresh `activeTab` grant (from a toolbar click) to capture a tab. Per-origin permission isn't enough.
- **Fix:** only plans with an enabled Screenshot step request `<all_urls>` (optional permission, once, at Run). Everything else stays per-site. This is documented in SECURITY/PRIVACY/store justifications. The badge is hidden while capturing. Captures are throttled to fewer than 2 per second, which is Chrome's limit.
- **Guard:** e2e "screenshots: page + element (cropped)". The test manifest pre-grants `<all_urls>` because headless tests can't click the prompt.
- **Note:** headless Chromium captures at the real window size (484×713 here), not the emulated viewport. The element crop (CSS px × devicePixelRatio) was exact.

## Test assumptions that broke (test-side lessons)

- Hover toolbars cover the middle of a step's title. Click the title **text** (`.block-title strong`), not the button's center.
- Imported steps start expanded, so clicking the title collapses them.
- The text backup made a "missing element" test pass. Tests that expect failure must clear `fallbackText`.

## Upgrades from research

Sources: recorder-extension designs and retry-strategy guidance; see the commit message.

- A retry changes something material: each retry waits 2× longer (`retries` setting, 0–3, default 1).
- Selector fallback: Click steps record the element's visible text and use it if the selector stops matching.
- Debugging: ▶ test a single step; Find highlights the selector's matches and shows the count.
- Undo for deleted steps. A live activity log with timings and screenshots. The page badge shows the current run and step.
