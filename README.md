# ClickFlow

A Chrome extension for automating repetitive clicks and typing on web pages. You build a plan out of steps, and ClickFlow runs it as many times as you choose. Each text box can take the next value from its own list on every run.

![promo](store/promo-small-440x280.png)

## Features

- **Record instead of building by hand.** Press **Record** and use the page as you normally would. Each click, text entry, and dropdown choice appears as a step. Clicks on items in scrollable lists become "find in list" steps, so they keep working when the list moves or loads more items. Typing into the same field is combined into a single step. Password and payment fields are never recorded.
- **Data sets: a separate list for each text box.** In the **Data** tab, press **+ Add data set** to create a named list of strings, one per line or comma-separated. Make one for each field that needs different values, for example `names` for the first text box and `emails` for the second. On run 1 each step gets the 1st value of its set, on run 2 the 2nd, and so on.
- **Choose the data set from a dropdown.** Type text and Select steps have a **Value** dropdown: *Fixed text*, any of your data sets, or *+ New data set*. That last option creates a set named after the field (`#email` becomes `email`), starting with the text you recorded.
- **Runs are counted for you.** In **Automatic** mode (the default), ClickFlow counts the values in each data set your steps use and does one run per value. If several sets are used, it follows the **shortest** one. Switch to **Fixed number** to choose the count yourself (quick buttons for 1, 3, 5, and 10), and choose what happens when a set runs out: start over, leave the field empty, or stop.
- **Right-click and double-click.** A Click step's **Mouse button** can be Left, Right (opens a page's custom context menu), or Double. Recording captures right-clicks and double-clicks too.
- **Screenshots.** A Screenshot step captures the visible page or a single element, named with `{{index}}` or a data set value. Images appear in the activity log, where you can view and download them one at a time or all at once. Images are kept only in the panel while it's open. Taking screenshots requires all-sites access, which ClickFlow asks for the first time you run a plan with a Screenshot step (this is Chrome's rule for capturing tabs).
- **Live activity log.** While a plan runs, the log shows every step with ✓ or ✗, its real values, and how long it took, plus retries and errors. When most of a step's time went to waiting for the next page, the log says so. Drag the log's top edge to resize it; double-click the edge to reset. The badge on the page shows the current run and step.
- **Built to survive page changes.** Click steps keep the recorded text as a backup ("If not found, click the element with this text"), so a selector broken by a site update still finds its button or link. Steps wait until their element is visible, not just present in the page, for up to the time set in Settings → *Wait for elements up to* (one setting for every step). Failed steps are retried with a longer wait (*Retry a failed step*).
- **Debug a single step.** Hover over a step and press ▶ to run just that step on the page. Press the search icon next to **Pick** to highlight what a selector matches and see how many elements it finds. Deleting a step shows an **Undo** button.
- **Fast.** Each step adds about 50 ms of overhead (measured by the e2e test), plus the delays you set (default 100 ms between steps and 300 ms between runs). After a step opens a new page, the next step starts as soon as that page's content is ready, without waiting for slow images, ads, or trackers.
- **Steps you can rearrange.** Each step is a block: Click, Type text, Select / find in list, Wait, Scroll, or Screenshot. You can drag blocks to reorder them, move them with the arrow buttons or the keyboard (focus the handle, then press ↑/↓), and duplicate, disable, or delete them.
- **Element picker.** Click **Pick**, then click any element on the page. ClickFlow fills in a stable CSS selector for it.
- **Works with dropdowns and long lists.** ClickFlow handles native `<select>` menus, and it can scroll custom lists, including lazy-loading ones, until it finds the value you asked for.
- **Clear control while running.** A progress bar shows run and step, and the current step is highlighted. Pause and Stop take effect immediately, even in the middle of a step: Pause freezes the step (and its wait time) until you resume, and Stop ends the run at once. Pressing Esc on the page also stops the run. A badge on the page shows when ClickFlow is acting.
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
