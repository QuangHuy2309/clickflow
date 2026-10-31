# Security

ClickFlow can click and type inside your web pages, so it is designed to do as little as possible and to touch only what you allow.

## Permissions

| Permission | Why | Install warning |
|---|---|---|
| `sidePanel` | Shows the editor in Chrome's side panel. | none |
| `storage` | Saves your plans locally (`chrome.storage.local`). | none |
| `scripting` | Runs a step in the tab after you press **Run** or **Pick**. | none |
| `activeTab` | Gives temporary access to the current tab when you click the toolbar icon. | none |
| `<all_urls>` (**optional**) | Never granted at install. ClickFlow asks for **one site at a time** the first time you run or pick on that site. You can revoke access in `chrome://extensions`. | shown only when requested |

ClickFlow has no content scripts that run on every page, and its service worker does nothing except open the side panel.

## Design rules

- **No remote code.** There is no `eval`, no `new Function`, no CDN scripts, and no network requests of any kind. The default Manifest V3 content security policy is unchanged.
- **Steps are data, not code.** Each step is sent to the page as a plain JSON object through `chrome.scripting.executeScript({ func, args })`. The only code that runs is the code bundled in `src/content/`.
- **No HTML injection.** The UI is built with `createElement` and `textContent`, never `innerHTML`. Plan names, selectors, and text are always displayed as plain text.
- **Imported plans are untrusted.** Imports are limited to 1 MB and validated against a strict schema (`src/shared/schema.js`): unknown step types and keys are dropped, strings are length-limited, and numbers are clamped. A preview is shown before anything is saved.
- **Bounded execution.** A run can have at most 10,000 iterations and 200 steps, and every wait has a timeout. Stop, Pause, and Esc on the page all work while a run is in progress.
- **One target tab.** A run is locked to the tab it started in.
- **Restricted pages.** ClickFlow refuses to run on `chrome://` pages, other internal browser pages, and the Chrome Web Store. It runs on local `file://` pages only if you enable that yourself.
- **On-page UI is isolated.** The picker overlay and the running badge live in a closed shadow root, so the page's scripts can't restyle them or read them through the DOM.

## Things to keep in mind

- Plans and data lists are stored **unencrypted** on your device. Don't put passwords or other secrets in them.
- Only import plans from people you trust, and read through the steps before you press Run.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security → Report a vulnerability) rather than a public issue.
