# 2026-10-31: Google search review

Reported by the user: a plan recorded on Google failed at step 2 with `Couldn't find "div:nth-of-type(3) > a.C6AK7c" within 5000 ms`, search fields without a submit button didn't work, and recording sometimes missed actions. Regression tests are in `test/e2e.mjs` (section "Google-like search site"), which runs against `test/search.html`, `results.html`, and `article.html`.

## Enter did not submit a `<textarea>` search box

- **Symptom:** "Type text" with **Press Enter after typing** did nothing on Google, so the results never loaded and the next step (clicking a result) timed out.
- **Root cause:** Two problems. (1) Google's search box is a `<textarea>`, and the form-submit fallback only handled `<input>`. (2) Key events created in the content script's isolated world report `keyCode`/`which` as 0 to page scripts, even if you redefine them, because the page sees its own wrapper of the event. Handlers that check `e.keyCode === 13` ignored the Enter.
- **Fix:** `pressEnterInPage` in `src/sidepanel/runner.js` runs with `world: 'MAIN'`. It dispatches keydown/keypress/keyup with `keyCode`/`which` set to 13. If no handler cancelled the keydown and no navigation started within 250 ms, it calls `requestSubmit()` on the field's form, which works for inputs and textareas.
- **Guard:** e2e "replay: Enter submitted the search" (a textarea with no submit button that reacts only to keyCode 13) and "Enter reached a keyCode-checking handler on a field with no form".

## Recorded selectors used generated ids and classes

- **Symptom:** recorded selectors such as `#ti6dpd` and `a.C6AK7c` that change on every page load.
- **Root cause:** the selector builder trusted any id without 4+ digits, and any class without 3+ digits.
- **Fix:** `src/content/selector.js` has a `looksGenerated()` check (letters and digits mixed in short tokens, hex runs, `:r3:` style). The preference order is now: form field `name`/`aria-label`/`placeholder` → hand-written id → test ids / `aria-label` / `title` → link `href` → generated id → structural path.
- **Guard:** e2e "selector builder prefers name/href and skips generated ids/classes". The test pages regenerate ids and classes and add random wrapper depth on every load.

## Recorder missed Enter in a `<textarea>`

- **Symptom:** recording "type a query, press Enter" on Google captured the text but not the Enter.
- **Root cause:** Enter was ignored for textareas on purpose (it's normally a new line).
- **Fix:** `recorder.js` marks the textarea as a candidate on keydown (capture phase). A bubble-phase `window` listener then records Enter if the page cancelled the default (that is, it handled Enter as submit). If navigation starts first, `pagehide` records it.
- **Guard:** e2e "recorded textarea + Enter across a page navigation".

## Recorder logged "Click body" for suggestions that act on mousedown

- **Symptom:** clicking an autocomplete suggestion was recorded as a click on `body`, or not recorded at all.
- **Root cause:** the suggestion hides itself on mousedown. The browser then sends `click` to the common ancestor of the mousedown and mouseup targets (`<body>`), or sends no click at all if the page navigates.
- **Fix:** the recorder captures the target and builds its step on `pointerdown`. A click that lands on an ancestor of the pressed element records the pressed element instead. If no click arrives and the element is gone (or the page navigates), the step captured on pointerdown is sent.
- **Guard:** e2e "recorded and replayed a mousedown-only suggestion".

## Typing lost when the page navigated right away

- **Symptom:** typed text sometimes missing from a recording.
- **Root cause:** typing is batched for 700 ms. A navigation inside that window destroyed the pending timer.
- **Fix:** the typed value and selector are captured on each `input` event, and pending typing is flushed on `pointerdown`, `pagehide`, and `beforeunload`.
- **Guard:** covered by the recording tests above, which all navigate right after typing.

## Known limits (not fixed)

- Elements inside iframes and closed shadow roots can't be recorded or replayed (top frame only).
- Keyboard-only selection (arrow keys + Enter in a suggestion list) records the typing and Enter, not the highlighted suggestion.
- Sites that check `event.isTrusted` will ignore synthetic input. Working around that would need the `debugger` permission, which isn't worth it for a store extension.
