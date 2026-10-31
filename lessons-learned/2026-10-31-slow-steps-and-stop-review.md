# 2026-10-31: Slow steps on Google, Stop that acted like Pause, shared timeout, resizable log

Reported by the user (v1.1.0 log from a Google plan): Type + Enter steps took 58–70 s while the other steps took 1–2 s. Stop felt like Pause. They also asked for one shared "wait for element" setting and a resizable log.

Regression tests are in `test/e2e.mjs`:
- "element timeout is one plan setting"
- "pause froze the step…"
- "stop ended the run in … ms"
- "next step ran … after a page whose load takes 10 s" (`test/slow.html`, with an image the test server holds for 10 s)
- "log resized…"

## Steps waited for every image, ad and tracker on the next page

- **Symptom:** after a step that navigates (Enter in the search box, a click), the step took about a minute on Google.
- **Root cause:** `_waitForLoad` polled until the tab's status was `complete`, which means the window `load` event, after all subresources. On busy sites (or slow networks) that can take 30 s or more. The cap was 30 s, and one step could hit it twice: the retry path after a "frame removed" error waited, and so did the check after Enter. That gives about 60 s. A step that *didn't* navigate also waited whenever the tab still said `loading` because of a slow image. Page calls also used the default injection timing, which waits for Chrome's "document idle".
- **Could not reproduce on Google itself:** automated Chromium gets a reCAPTCHA page. Reproduced the mechanism locally with an image held by the server: about 10 s before the fix, 0.1 s after.
- **Fix (`runner.js`, `actions.js`):**
  - `_settle(doc)` waits only until a *different* document has parsed its HTML (`readyState !== 'loading'`), or until the tab is complete, whichever comes first, with a 15 s cap. The next step still waits for its own element.
  - Each page load has an id (`window.__clickflow.doc`), returned with every step result, so the runner knows when the old page has been replaced.
  - If no navigation started and the step's own page is still there, it returns immediately, even if the tab says `loading`.
  - Every `executeScript` uses `injectImmediately: true`.
  - The log shows "X s of it waiting for the next page to load", so slow sites aren't mistaken for slow steps.
- **Guard:** the slow-page e2e test (must finish in < 4 s with a 10 s image).

## Stop and Pause only took effect between steps

- **Symptom:** pressing Stop during a long wait looked like a pause: nothing happened for seconds, then the run ended. Pause showed "Paused", but the current step kept running and could time out.
- **Root cause:** the runner checked `_stopped` and `paused` only between steps. In-flight `await`s (page call, page-load wait, Enter) ran to completion first. The page-side wait kept its own clock running during a pause.
- **Fix:**
  - **Stop:** every await in a step goes through `_guard()`, which races it against a stop signal (and a hang limit), so Stop unwinds the run immediately and tells the page to abort.
  - **Pause:** sends `pause(true)` to the page, which freezes `waitFor` (its timeout clock too) and the list-scrolling loop. Every page call also carries the pause state, because a pause sent while actions.js is still being injected was lost (an e2e test caught this as a flaky failure).
  - Paused time isn't counted in a step's duration.
- **Guard:** e2e Stop must end the run in < 1 s mid-wait. The e2e Pause test holds past the timeout, adds the element while paused, then checks the run doesn't move until Resume.

## A page call could hang a run forever

- **Root cause:** `chrome.scripting.executeScript` has no timeout. A frozen page (or one that never answers) held the run forever.
- **Fix:** page calls are limited to the step timeout + 5 s (Select steps 3×). A hang is retried once on a ready page, then reported as "The page stopped responding". Fire-and-forget calls (badge, abort) are capped at 2 s.

## One timeout for all steps

- **Change:** the per-step "Wait for element up to (ms)" and the Wait step's "Give up after (ms)" were replaced by Settings → *Wait for elements up to (ms)* (`plan.timeout`, 500–120000, default 5000). Older plans are migrated to the value most of their steps used, preferring the longer value on a tie.
- **Guard:** unit test "sanitizePlan: one shared element timeout…".

## Test-side lessons

- Measure Stop from the moment the run is actually underway. Clicking a button that isn't visible yet makes Playwright wait, and that wait got counted as Stop latency.
- A new test that fails right away is the point. The slow-page test caught a second bug: a non-navigating step waiting on a `loading` tab.

## The log looked detached from the steps (follow-up)

- **Symptom:** with the log open, resizing it didn't visibly shorten the steps. The log was a floating card with margins and a shadow, and there was empty space between the steps and the log.
- **Fix (`panel.css`, `panel.js`):** the log is docked as a split view: full width, a divider on its top edge, a default height of 38vh, and `flex: none` under `main` (which is `flex: 1`). It can be dragged from the divider or the header, the running step stays in view while dragging, and double-clicking resets the size.
- **Guard:** e2e checks that the steps area ends where the log begins, and that it shrinks by exactly the amount the log grows.
