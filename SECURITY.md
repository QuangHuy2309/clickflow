# Security

ClickFlow can click and type inside your web pages, so it is designed to do as little as possible and to touch only what you allow.

## Permissions

| Permission | Why | Install warning |
|---|---|---|
| `sidePanel` | Shows the editor in Chrome's side panel. | none |
| `storage` | Saves your plans locally (`chrome.storage.local`). | none |
| `scripting` | Runs a step in the tab after you press **Run** or **Pick**. | none |
| `activeTab` | Gives temporary access to the current tab when you click the toolbar icon. | none |
| `<all_urls>` (**optional**) | Never granted at install. ClickFlow asks for **one site at a time** the first time you run or pick on that site. The one exception is plans with **Screenshot** steps: Chrome only lets an extension capture a tab if it has all-sites access, so that is requested (once, at Run) only for those plans. You can revoke access in `chrome://extensions`. | shown only when requested |

ClickFlow has no content scripts that run on every page, and its service worker does nothing except open the side panel.

## Design rules

- **No remote code.** There is no `eval`, no `new Function`, no CDN scripts, and no network requests of any kind. The default Manifest V3 content security policy is unchanged.
- **Steps are data, not code.** Each step is sent to the page as a plain JSON object through `chrome.scripting.executeScript({ func, args })`. The only code that runs is the code bundled in `src/content/`.
- **No HTML injection.** The UI is built with `createElement` and `textContent`, never `innerHTML`. Plan names, selectors, and text are always displayed as plain text. Translations are plain strings bundled with the extension and are shown the same way.
- **Imported plans are untrusted.** Imports are limited to 1 MB and validated against a strict schema (`src/shared/schema.js`): unknown step types and keys are dropped, strings are length-limited, and numbers are clamped. A preview is shown before anything is saved.
- **The recorder is limited.**
  - It's injected only after you press Record, and only into that tab. It's re-injected after page loads in that tab and removed when you press Stop.
  - It records only real user input (`event.isTrusted`), so scripts on the page can't add steps.
  - It never records the contents of password fields, or of fields marked as payment, one-time-code, or password autocomplete. Those steps are saved with an empty value and a note.
  - The panel accepts recorded steps only from the recording tab and only with the current session ID. Each step goes through the same schema sanitizer as an import.
- **Screenshots stay local.** Captured images are kept in the side panel's memory and are discarded when it closes. They're saved only when you press Download, and never uploaded. The page badge is hidden while capturing.
- **Enter from the page context.** To press Enter in a way page scripts recognize (`keyCode` 13), ClickFlow runs one small bundled function in the page's main world. It only dispatches key events to the step's field and submits that field's form if nothing reacted.
- **Bounded execution.** A run can have at most 10,000 iterations and 200 steps, and every wait has a timeout (a step's "Then wait" is under an hour). Every call into the page has a time limit, so a frozen page can't hang a run. Stop, Pause, and Esc on the page take effect immediately, even mid-step.
- **One target tab.** A run is locked to the tab it started in. The one thing it opens elsewhere is links clicked by a step inside a **For each row** loop: only `http`/`https` links are opened (checked in the page and again in the panel), as background tabs, at most one per step per row and 500 rows per loop. Opening tabs needs no extra permission, and ClickFlow doesn't run steps in those tabs.
- **Restricted pages.** ClickFlow refuses to run on `chrome://` pages, other internal browser pages, and the Chrome Web Store. It runs on local `file://` pages only if you enable that yourself.
- **On-page UI is isolated.** The picker overlay and the running badge live in a closed shadow root, so the page's scripts can't restyle them or read them through the DOM.

## Things to keep in mind

- Plans and data sets are stored **unencrypted** on your device. Don't put passwords or other secrets in them.
- Only import plans from people you trust, and read through the steps before you press Run.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security → Report a vulnerability) rather than a public issue.
