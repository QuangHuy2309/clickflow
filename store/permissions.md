# Privacy practices tab: text to paste

## Permission justifications

**sidePanel**
Shows ClickFlow's plan editor and run controls in Chrome's side panel, so it stays open next to the page being automated.

**storage**
Saves the user's automation plans (steps, selectors, data sets, settings) locally on their device with chrome.storage.local. Nothing is synced or sent anywhere.

**scripting**
When the user presses Record, Run, or Pick, ClickFlow injects its own bundled script into the active tab. Depending on the button, the script records the user's clicks and typing as steps (password and payment fields are excluded), carries out the user's steps (click, type, select, scroll, wait), or lets them pick an element. No remote code is ever run.

**activeTab**
Gives ClickFlow temporary access to the current tab when the user clicks the toolbar icon, so it can identify the page and ask for site access.

**Host permissions (optional_host_permissions: <all_urls>)**
These are optional and never granted at install. The extension calls chrome.permissions.request for a single site (for example https://example.com/*) only when the user chooses to record, run a plan, or pick an element on that site. The user can automate any site they choose, so the specific sites can't be known in advance.

## Remote code
No, I am not using remote code. All JavaScript is included in the package.

## Data usage
Tick **none** of the data categories. ClickFlow does not collect or transmit any user data.

Certify all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

## Submission checklist
1. Register a developer account at https://chrome.google.com/webstore/devconsole (one-time US$5 fee) and verify your email.
2. Run `scripts/package.ps1`, then upload `dist/clickflow-<version>.zip`.
3. Store listing tab: paste from `store/listing.md`, then upload the icon, the promo tile, and at least one screenshot.
4. Privacy tab: paste the justifications above and the privacy policy URL. The repo must be public, or PRIVACY.md hosted elsewhere, before you submit.
5. Distribution: Public, all regions. Then submit for review.
