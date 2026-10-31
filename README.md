# ClickFlow

A Chrome extension for automating repetitive clicks and typing on web pages. You build a plan out of steps, and ClickFlow runs it once for every item in a data list.

![promo](store/promo-small-440x280.png)

## Features

- **Steps you can rearrange.** Each step is a block: Click, Type text, Select / find in list, Wait, or Scroll. You can drag blocks to reorder them, move them with the arrow buttons or the keyboard (focus the handle, then press ↑/↓), and duplicate, disable, or delete them.
- **Data-driven runs.** Paste a list (one item per line, or separated by commas) and the plan runs once per item. Use `{{value}}` in any step to insert the current item, and `{{index}}` for the run number.
- **Element picker.** Click **Pick**, then click any element on the page. ClickFlow fills in a stable CSS selector for it.
- **Works with dropdowns and long lists.** ClickFlow handles native `<select>` menus, and it can scroll custom lists, including lazy-loading ones, until it finds the value you asked for.
- **Clear control while running.** A progress bar shows run and step, and the current step is highlighted. You can pause, resume, or stop at any time, and pressing Esc on the page also stops the run. A badge on the page shows when ClickFlow is acting.
- **Multiple plans.** Create, rename, duplicate, and delete plans, and import or export them as JSON.
- Light and dark themes, keyboard accessible, and no dependencies.

## Install (development)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the ClickFlow toolbar icon to open the side panel.

## Try it

```sh
npm run playground   # serves test/playground.html on http://localhost:5500
```

Open `http://localhost:5500/playground.html` and click the ClickFlow icon. Allow access to `localhost`, then build this plan:

| # | Step | Settings |
|---|------|----------|
| 1 | Type text | Input field `#name`, text `{{value}}` |
| 2 | Select / find in list | `#country`, value `Japan` |
| 3 | Select / find in list | List `#cityList`, opener `#cityBtn`, value `Tokyo` |
| 4 | Click | `#submit` |

For the data list, enter `alice, bob, carol` and press **Run**. The Submissions box on the page should show three entries.

## Development

```sh
npm test            # unit tests (node:test, no dependencies)
npm run icons       # regenerate icons/ and the store promo tile
./scripts/package.ps1   # or scripts/package.sh: builds dist/clickflow-<version>.zip
```

### Project layout

```
manifest.json            MV3 manifest
src/background.js        opens the side panel on toolbar click
src/sidepanel/           UI (index.html, panel.css, panel.js), runner, storage, site access
src/shared/              plan schema + sanitizer, data-list parsing and templating
src/content/actions.js   step executor, injected only while a plan runs
src/content/picker.js    element picker, injected only when you click Pick
test/                    unit tests and the playground page
store/                   Chrome Web Store listing text, permission justifications, images
```

## Limitations

- ClickFlow sends synthetic events (`isTrusted` is `false`). Most sites accept them, but some deliberately ignore them.
- It only works in the top-level page, not inside iframes.
- Chrome blocks every extension on `chrome://` pages and the Chrome Web Store.

## Responsible use

Only automate sites you're allowed to automate, and follow each site's terms of service. ClickFlow is not designed to get around CAPTCHAs, rate limits, or other anti-automation measures.

## Security & privacy

See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md). In short: ClickFlow collects nothing and makes no network requests, and it can only touch the sites you explicitly allow.

## License

[MIT](LICENSE)
