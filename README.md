# site-autofix

A Node.js CLI tool that detects broken links, auto-fixes href references, generates redirect configurations for major platforms, and monitors endpoints for 500-class server errors.

## What it does

- **Broken Link Detection**: Crawls your site using Playwright, discovers all internal links, and checks each one for 404s, redirect chains, and server errors.
- **Auto-Fix Suggestions**: Computes fix suggestions for broken links using fuzzy matching and path similarity against known-good URLs. Applies fixes to source files when confidence is high enough.
- **Redirect Generation**: Produces ready-to-use redirect configurations for Next.js (`next.config.js` redirects array), Netlify (`_redirects` file), and nginx (`map` block).
- **Health Monitoring**: Performs periodic synthetic checks against your endpoints, detects 500-class errors, extracts stack traces, classifies the error pattern (timeout, OOM, database, upstream, config, unhandled exception), and recommends bounded remediation actions (restart, rollback, feature-flag-off, or open-issue).

## Installation

```bash
npm install -g site-autofix
```

Or run directly from the repo:

```bash
git clone <repo-url>
cd site-autofix
npm install
npm run build
```

## CLI Reference

### `site-autofix scan <url>`

Crawl a site and report broken links.

```bash
site-autofix scan https://example.com
```

| Option | Default | Description |
|---|---|---|
| `--max-pages <n>` | 100 | Maximum pages to crawl |
| `--timeout <ms>` | 15000 | Request timeout |
| `--concurrency <n>` | 5 | Concurrent link checks |
| `--exclude <patterns...>` | — | URL patterns to exclude (regex) |
| `--output <format>` | console | Output: `json`, `console`, or `both` |
| `--output-file <path>` | — | Write JSON report to file |

Exit codes: `0` = all links healthy, `1` = broken links found, `2` = scan error.

### `site-autofix fix <url>`

Scan for broken links and generate redirect configurations.

```bash
site-autofix fix https://example.com --target ./redirects --format netlify
```

| Option | Default | Description |
|---|---|---|
| `--target <dir>` | `.` | Directory to write redirect configs |
| `--format <fmt>` | all | Redirect format: `nextjs`, `netlify`, `nginx`, or `all` |
| `--min-confidence <n>` | 0.5 | Minimum confidence threshold (0-1) |
| `--max-pages <n>` | 100 | Maximum pages to crawl |
| `--timeout <ms>` | 15000 | Request timeout |
| `--concurrency <n>` | 5 | Concurrent link checks |
| `--output <format>` | console | Output: `json`, `console`, or `both` |
| `--output-file <path>` | — | Write JSON report to file |

Generated files:
- `generated-redirects.js` (Next.js)
- `_redirects` (Netlify)
- `nginx-redirects.conf` (nginx)

### `site-autofix monitor <url>`

Periodically check endpoints for 500-class errors.

```bash
site-autofix monitor https://example.com --endpoints / /api/health /api/data --rounds 5
```

| Option | Default | Description |
|---|---|---|
| `--endpoints <paths...>` | `/` | Endpoint paths to check |
| `--interval <ms>` | 30000 | Interval between rounds |
| `--timeout <ms>` | 10000 | Request timeout |
| `--rounds <n>` | 1 | Number of rounds (0 = indefinite) |
| `--output <format>` | console | Output: `json`, `console`, or `both` |
| `--output-file <path>` | — | Write JSON report to file |

Error classifications:
- `timeout` — Endpoint timed out
- `oom` — Out of memory detected
- `database-error` — Database connection issue
- `upstream-dependency` — Upstream service failure (502/503/504)
- `configuration-error` — Missing config or env vars
- `unhandled-exception` — Uncaught error with stack trace
- `unknown` — Unclassifiable error

Recommended actions per classification:
- `restart` — Restart the service (timeout, OOM, database)
- `rollback` — Roll back to last known good deploy (config errors)
- `feature-flag-off` — Disable the affected feature (unhandled exceptions)
- `open-issue` — File an issue with repro artifacts (upstream, unknown)

## Architecture

```
src/
  cli.ts                 CLI entry point (commander)
  types.ts               Shared TypeScript types
  link-scanner.ts        Crawl + check links (Playwright + fetch)
  link-fixer.ts          Fuzzy matching + fix computation
  redirect-generator.ts  Next.js / Netlify / nginx config output
  health-monitor.ts      Synthetic health checks + error classification
  reporter.ts            Console + JSON output formatting
```

## How it works

1. **Scanning** uses Playwright to render pages (handling JS-rendered content), then extracts all `<a href>` elements. Each discovered internal link is checked via `fetch` with redirect tracking.

2. **Fixing** takes the broken links and compares them against known-good URLs using a weighted combination of path segment overlap (60%) and Levenshtein edit distance (40%). Links with redirect targets get a 95% confidence automatic fix.

3. **Redirect generation** converts the fix map into platform-specific config files, each with inline comments explaining how to integrate them.

4. **Monitoring** runs periodic `fetch` requests against configured endpoints, collects response headers and bodies for failing requests, extracts stack traces using regex patterns for Node.js/Python/Java/Ruby, classifies the error, and maps it to a bounded remediation action.

## Requirements

- Node.js >= 18
- Playwright browsers (installed automatically on first run, or run `npx playwright install chromium`)

## License

MIT
