// One-time setup for .github/workflows/publish.yml: gets a Chrome Web Store
// refresh token through Google sign-in on this computer, then stores the four
// CWS_* secrets in the "chrome-web-store" GitHub environment with `gh`.
// Secret values are never printed or written to disk.
//
// Usage: node scripts/cws-auth.mjs path/to/client_secret_….json
// (the JSON you download when creating the OAuth client, type "Desktop app")
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REPO = 'QuangHuy2309/clickflow';
const ENV = 'chrome-web-store';
const EXTENSION_ID = 'hnnkmkabfkidkcdalfldpdjpbafichgn';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/cws-auth.mjs path/to/client_secret.json');
  process.exit(1);
}
const json = JSON.parse(readFileSync(file, 'utf8'));
const { client_id: clientId, client_secret: clientSecret } = json.installed || json.web || {};
if (!clientId || !clientSecret) {
  console.error('That file has no client_id/client_secret. Download the JSON of a "Desktop app" OAuth client.');
  process.exit(1);
}

// PKCE + state: the code can only be redeemed by this process.
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/') { res.writeHead(404).end(); return; }
    const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(ok ? 'ClickFlow: access granted. You can close this tab.' : 'ClickFlow: sign-in was cancelled or did not match.');
    server.close();
    ok ? resolve(url.searchParams.get('code')) : reject(new Error(url.searchParams.get('error') || 'state mismatch'));
  }).listen(0, '127.0.0.1', () => {
    const redirect = `http://127.0.0.1:${server.address().port}`;
    server.redirect = redirect;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [k, v] of Object.entries({
      client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
    })) auth.searchParams.set(k, v);
    console.log('Sign in with the publisher account (lqhuy2309@gmail.com) in the browser that opens, then click Allow.');
    console.log(`If no browser opens, open this URL:\n${auth}\n`);
    spawn(process.platform === 'win32' ? 'cmd' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', auth.href] : [auth.href],
      { stdio: 'ignore', detached: true }).unref();
  });
  setTimeout(() => { server.close(); reject(new Error('Timed out after 5 minutes.')); }, 300000).unref();
  globalThis.redirectOf = () => server.redirect;
});

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier,
    grant_type: 'authorization_code', redirect_uri: globalThis.redirectOf(),
  }),
});
const token = await res.json();
if (!token.refresh_token) {
  console.error(`No refresh token: ${token.error || res.status} ${token.error_description || ''}`);
  process.exit(1);
}

// Values go to gh through stdin, never on the command line or the screen.
const secrets = { CWS_EXTENSION_ID: EXTENSION_ID, CWS_CLIENT_ID: clientId, CWS_CLIENT_SECRET: clientSecret, CWS_REFRESH_TOKEN: token.refresh_token };
for (const [name, value] of Object.entries(secrets)) {
  execFileSync('gh', ['secret', 'set', name, '--env', ENV, '--repo', REPO], { input: value, stdio: ['pipe', 'ignore', 'inherit'] });
  console.log(`✓ ${name} saved to the ${ENV} environment`);
}
console.log('\nDone. You can delete the downloaded client_secret JSON now.');
