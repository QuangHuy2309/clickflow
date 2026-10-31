# ClickFlow: notes for Claude

Chrome MV3 side-panel extension: record or build step plans (click, type, select, wait, scroll), run them N times, and fill fields from named data sets. Vanilla JS, no build step, no runtime dependencies.

## Rules

- **Never push** to GitHub until the user explicitly says so. The target is the public repo `QuangHuy2309/clickflow`, with a ruleset on `master` requiring a PR review (the owner can bypass).
- **After every review or bug report, update [lessons-learned/](lessons-learned/README.md)** with symptom, root cause, fix, and guard, and add a row to its index. Add a regression test for each reported bug, ideally failing before the fix.
- Keep Chrome Web Store compliance: no remote code, no network requests, minimal permissions (host access stays optional and per site). Update `PRIVACY.md`, `SECURITY.md`, and `store/` when behavior changes.
- Build UI with `h()` / `textContent`; never `innerHTML`. Everything imported or recorded goes through `sanitizePlan` / `sanitizeBlock`.

## Commands

```sh
npm test                 # unit tests (node:test)
npm run e2e              # Playwright e2e; needs PLAYWRIGHT_BROWSERS_PATH=.playwright (browsers live in the repo, gitignored)
./scripts/package.ps1    # store zip in dist/
```

The e2e test loads a copy of the extension with `http://127.0.0.1/*` pre-granted and serves `test/*.html`. `test/search.html` is a Google-like page used for regression tests.

## Windows tooling

Put temporary scripts in `.playwright/scratch/` (gitignored). Commit with `git commit -F <file>`. Don't rewrite UTF-8 files with PowerShell `Get-Content`/`Set-Content`.
