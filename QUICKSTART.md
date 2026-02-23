# Quickstart

Get started with site-autofix in one command.

## Install and scan

```bash
git clone <repo-url> && cd site-autofix && npm install && npm run build && node dist/cli.js scan https://example.com
```

## Step by step

### 1. Install

```bash
npm install
npm run build
```

### 2. Scan a site for broken links

```bash
node dist/cli.js scan https://example.com --max-pages 20
```

This crawls up to 20 pages, checks every internal link, and prints a report showing 404s, redirect chains, and server errors.

### 3. Generate redirect configs

```bash
node dist/cli.js fix https://example.com --target ./redirects --format all
```

This scans the site, computes fixes for broken links, and writes redirect configurations for Next.js, Netlify, and nginx into the `./redirects` directory.

### 4. Monitor for 500 errors

```bash
node dist/cli.js monitor https://example.com --endpoints / /api/health --rounds 3 --interval 10000
```

This checks the `/` and `/api/health` endpoints 3 times at 10-second intervals. Any 500-class errors are classified and a remediation action is recommended.

### 5. Save reports as JSON

Add `--output json --output-file report.json` to any command to get machine-readable output:

```bash
node dist/cli.js scan https://example.com --output json --output-file scan-report.json
```

## Using as a global CLI

After building, you can link it globally:

```bash
npm link
site-autofix scan https://example.com
```
