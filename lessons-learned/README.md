# Lessons learned

A running log of bugs found in reviews and testing: what broke, why, and what now stops it from coming back. **Add an entry after every review or bug report** (see [CLAUDE.md](../CLAUDE.md)).

## Index

| Date | Entry | Topics |
|---|---|---|
| 2026-10-31 | [Then wait, For each row, Vietnamese](2026-10-31-wait-rows-vietnamese.md) | tab opener window, retry after side effects, i18n keys, CSS specificity, baseline under load, row loop as a container, pointer drag, nested CSS state |
| 2026-10-31 | [Slow steps & Stop review](2026-10-31-slow-steps-and-stop-review.md) | waiting for full page load, Stop/Pause only between steps, hung page calls, shared timeout |
| 2026-10-31 | [Speed & upgrades review](2026-10-31-speed-and-upgrades-review.md) | per-step overhead 160→49 ms, auto run count, hidden-element clicks, screenshot permission, test assumptions |
| 2026-10-31 | [Google search review](2026-10-31-google-search-review.md) | Enter in `<textarea>`, isolated-world `keyCode`, generated ids/classes, recorder gaps |
| 2026-10-31 | [Initial build](2026-10-31-initial-build.md) | `hidden` vs CSS `display`, extension CSP vs test tools, picker race, scroll budget, Windows shell encoding |

## How to add an entry

Create `YYYY-MM-DD-short-topic.md` with one section per lesson, and add a row to the index above (newest first).

```markdown
## <Short name of the problem>

- **Symptom:** what the user saw
- **Root cause:** why it happened
- **Fix:** what changed (files)
- **Guard:** the test or rule that now catches it
```

## Recurring rules (distilled)

1. **Test against hostile, realistic pages.** Generated ids, obfuscated classes, `<textarea>` search boxes, widgets that act on mousedown, and handlers that check `keyCode`. `test/search.html` reproduces these.
2. **Events created in a content script are not what the page sees.** Properties added in the isolated world (such as `keyCode`) are invisible to page scripts. Dispatch from `world: 'MAIN'` when page handlers need them.
3. **Anything set with `[hidden]` needs `[hidden] { display: none !important; }`** wherever a class sets `display`, including inside shadow roots.
4. **Register state before you trigger an async action that can reply.** Example: store the pick request before activating the picker.
5. **Never trust a selector the browser can regenerate.** Prefer `name`, `aria-label`, test ids, or `href` over ids and classes that look generated.
6. **Every user-reported bug gets a failing e2e test first**, then the fix.
7. **Measure before optimizing, and keep the measurement as a test.** The e2e speed budget catches regressions in per-step overhead.
8. **Act like a person.** Wait for elements to be visible, not just present, before clicking or typing.
9. **Check Chrome's permission rules for each API early.** Some, like `captureVisibleTab`, need more than per-site access.
10. **Never wait for the tab's `complete` status.** Wait for the content you need: a new document that has parsed its HTML, then the element itself.
11. **Every await in a run must be stoppable and bounded.** Race it against Stop and a time limit. Controls that act only "between steps" feel broken.
12. **Don't retry a step that already had side effects** (tabs opened, rows clicked). Retry only from a clean state.
13. **Every UI string goes through t()**, and logic never reads displayed text. The i18n test catches missing translations.
14. **Nested UI: style state with child combinators** (`.block.is-error > .step-card`), or a parent's state leaks into its children.
