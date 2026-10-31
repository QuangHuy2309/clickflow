# ClickFlow

A Chrome extension for automating repetitive clicks and typing on web pages. You build a plan out of steps, and ClickFlow runs it once for every row of a data table.

![promo](store/promo-small-440x280.png)

## Features

- **Record instead of building by hand.** Press **Record** and use the page as you normally would. Each click, text entry, and dropdown choice appears as a step. Clicks on items in scrollable lists become "find in list" steps, so they keep working when the list moves or loads more items. Typing into the same field is combined into a single step. Password and payment fields are never recorded.
- **One-click variables.** On a recorded field, press `{{ }}` to fill it from the data table instead. The recorded value becomes the first row. Each field you do this for gets its own column, named after the field (`#email` becomes `email`). Once the table has more than one column, text fields show a **dropdown** where you choose *Fixed text*, a column, or *+ New column*, so you don't have to type placeholders.
- **Steps you can rearrange.** Each step is a block: Click, Type text, Select / find in list, Wait, or Scroll. You can drag blocks to reorder them, move them with the arrow buttons or the keyboard (focus the handle, then press ↑/↓), and duplicate, disable, or delete them.
- **Data-driven runs with multiple values.** The Data tab is a table: each **row** is one run and each **column** is a named value such as `{{name}}` or `{{email}}`. You can edit cells directly (Enter moves down a row), paste from Excel or Google Sheets into any cell or with **Paste…**, and add, rename, or delete columns. Renaming a column updates every step that uses it, and `{{index}}` gives the run number.
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

Open `http://localhost:5500/playground.html`, click the ClickFlow icon, and allow access to `localhost`.

**Quickest way:**
1. Press **Record**. Type a name and an email, choose a country, open the city list and pick a city, then click Submit.
2. Press **Stop**.
3. Press `{{ }}` on the name step and then on the email step. This creates the `name` and `email` columns.
4. On the city step, choose **+ New column** in the dropdown.
5. In the **Data** tab, paste a few rows (for example `bob<TAB>b@x.com<TAB>City 7`) and press **Run**.

**Or build the plan by hand:**

| # | Step | Settings |
|---|------|----------|
| 1 | Type text | Input field `#name`, text `{{name}}` |
| 2 | Type text | Input field `#email`, text `{{email}}` |
| 3 | Select / find in list | `#country`, value `Japan` |
| 4 | Select / find in list | List `#cityList`, opener `#cityBtn`, value `Tokyo` |
| 5 | Click | `#submit` |

In the Data tab, name the columns `name` and `email` and add three rows, then press **Run**. The Submissions box on the page should show three entries.

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
src/content/recorder.js  action recorder, injected only while you record
src/content/selector.js  shared stable-selector builder
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
