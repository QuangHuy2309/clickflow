# Publishing from GitHub

The Chrome Web Store has no built-in GitHub connection. `.github/workflows/publish.yml` fills the gap. It builds the zip, uploads it through the Chrome Web Store API, and optionally submits it for review.

It runs only when you start it (Actions → *Publish to Chrome Web Store* → Run workflow) or when you push a version tag such as `v1.3.0`. A tag must match the version in `manifest.json`, and a tag run also submits the new version for review. Every run waits for your approval, because the store credentials sit in a protected environment.

The store listing (description, images, privacy answers) is still edited in the dashboard. The API only updates the package.

## One-time setup

1. **Create a Google Cloud project** at https://console.cloud.google.com/ (any name, e.g. `clickflow-publish`).
2. **Turn on the API:** APIs & Services → Library → search for **Chrome Web Store API** → Enable.
3. **Set up the OAuth consent screen:** APIs & Services → OAuth consent screen.
   - User type **External**, app name `ClickFlow publisher`, your email as the support and developer contact.
   - Add yourself (`lqhuy2309@gmail.com`) as a **test user**.
4. **Create the OAuth client:** APIs & Services → Credentials → Create credentials → OAuth client ID → Application type **Desktop app**. Copy the **Client ID** and **Client secret**.
5. **Get a refresh token** (easiest: `node scripts/cws-auth.mjs path/to/client_secret.json`, which signs in, then stores all four secrets below with `gh` without showing them; or by hand:) Open this URL in the browser where you're signed in as the publisher account (put your client ID in place of `CLIENT_ID`):

   ```
   https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&prompt=consent&redirect_uri=http://localhost&client_id=CLIENT_ID
   ```

   Allow access. The browser then goes to `http://localhost/?code=…`, a page that won't load; that's expected. Copy the `code` value from the address bar, then run this on your own computer, in a terminal (not in a shared place):

   ```sh
   curl -s https://oauth2.googleapis.com/token -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET \
     -d code=CODE -d grant_type=authorization_code -d redirect_uri=http://localhost
   ```

   Copy `refresh_token` from the answer.
6. **Create the environment on GitHub:** repo → Settings → Environments → New environment `chrome-web-store`.
   - Tick **Required reviewers** and add yourself.
   - Under *Deployment branches and tags*, allow only `master` and tags `v*`.
7. **Add the environment secrets** (inside `chrome-web-store`, not repository-wide):

   | Secret | Value |
   |---|---|
   | `CWS_EXTENSION_ID` | `hnnkmkabfkidkcdalfldpdjpbafichgn` |
   | `CWS_CLIENT_ID` | from step 4 |
   | `CWS_CLIENT_SECRET` | from step 4 |
   | `CWS_REFRESH_TOKEN` | from step 5 |

## Releasing a new version

1. Raise `version` in `manifest.json` and `package.json`, and merge to `master` through a PR.
2. `git tag v1.3.1 && git push origin v1.3.1`
3. Approve the waiting run in the Actions tab. It runs the unit tests, uploads the zip, and submits it for review.

## Security notes

- The refresh token can upload and publish this extension under your account. Keep it only in the environment secrets, never in the repository, an issue, or a chat.
- **Revoking access:** remove *ClickFlow publisher* at https://myaccount.google.com/permissions, or delete the OAuth client.
- The workflow uses only `actions/checkout`, `actions/setup-node` and `curl`, with no third-party publishing action. It has read-only repository permissions, and it masks the access token in the logs.
- While the OAuth app is in "Testing" mode, Google expires refresh tokens after 7 days. To avoid that, publish the app (OAuth consent screen → Publish app). No verification is needed for your own use.
