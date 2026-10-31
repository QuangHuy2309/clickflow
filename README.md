# ClickFlow

A Chrome extension for automating repetitive clicks and typing on web pages. You build a plan out of steps, and ClickFlow runs it as many times as you choose. Each text box can take the next value from its own list on every run.

![promo](store/promo-small-440x280.png)

## Features

- **Record** clicks (left, right, double), typing, dropdown choices, and scrolls (page or one section) as steps. Password and payment fields are never recorded.
- **Steps as blocks:** Click, Type text, Select / find in list, Wait, Scroll, Screenshot, For each row. Drag them anywhere (also into and out of a row loop), move them with ↑/↓, duplicate, disable, or delete them.
- **Then wait** on any step: pause 1 s to 59 min before the next step, with a live countdown.
- **For each row:** pick one row of a list, set a rule (every row, ticked rows, or a cell that equals / is greater than / contains a value), and put steps inside. They run in each matching row, using elements picked in any row. Links clicked in a row open in background tabs, and ClickFlow scrolls to load more rows.
- **Data sets:** a named list of values per field. Run *n* uses value *n*, and ClickFlow counts the runs for you, or you set a fixed number.
- **Survives page changes:** stable selectors from the element picker, text fallback for clicks, waits for visible elements, retries.
- **Live log** with each step's values, timing, errors, and screenshots. Drag its top edge to resize it.
- **Fast, with instant control:** about 50 ms per step, no waiting for slow images or ads. Pause, Stop, and Esc act immediately.
- **Debug:** run one step, preview what a selector matches, undo a delete.
- **English and Vietnamese** (Settings → Language).
- Multiple plans with JSON import and export. Light and dark themes, keyboard accessible, no dependencies.

## Install (development)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the ClickFlow toolbar icon to open the side panel.

## Try it

```sh
npm run playground   # serves test/playground.html on http://localhost:5500
```

Open `http://localhost:5500/playground.html`, click the ClickFlow icon, and allow access to `localhost`.

1. Press **Record**. Type a name and an email, choose a country, open the city list and pick a city, then click Submit.
2. Press **Stop**.
3. Open the name step and choose **+ New data set** in its Value dropdown. Do the same on the email step.
4. In the **Data** tab, put three names in the `name` set and two emails in the `email` set.
5. In **Settings**, choose **3** runs and press **Run 3×**.

The Submissions box should show alice, bob, and carol. Because the email set is shorter, its values start over: a, b, then a again.

You can also build the same plan by hand: add Type text steps for `#name` and `#email` and set their Value dropdowns to your data sets.

## Development

```sh
npm test            # unit tests (node:test, no dependencies)
npm run icons       # regenerate icons/ and the store promo tile
./scripts/package.ps1   # or scripts/package.sh: builds dist/clickflow-<version>.zip
```

Publishing to the Chrome Web Store from GitHub (tag `vX.Y.Z` or run the workflow by hand): see [store/publish-from-github.md](store/publish-from-github.md).

### Project layout

```
manifest.json            MV3 manifest
src/background.js        opens the side panel on toolbar click
src/sidepanel/           UI (index.html, panel.css, panel.js), runner, storage, site access
src/shared/              plan schema + sanitizer, data-list parsing and templating, i18n (en, vi)
_locales/                extension name and description in English and Vietnamese
src/content/actions.js   step executor (incl. For each row), injected only while a plan runs
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
