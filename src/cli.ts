#!/usr/bin/env node

/**
 * cli.ts
 *
 * Main CLI entry point for site-autofix.
 *
 * Commands:
 *   scan <url>                 Crawl a site and find broken links
 *   fix <url> --target <dir>   Scan, compute fixes, and generate redirect configs
 *   monitor <url>              Watch endpoints for 500-class errors
 */

import { Command } from "commander";
import { scanSite } from "./link-scanner.js";
import { computeFixes, fixesToRedirects } from "./link-fixer.js";
import {
  writeAllRedirectConfigs,
  writeRedirectConfig,
} from "./redirect-generator.js";
import { monitor } from "./health-monitor.js";
import {
  reportScan,
  reportFixes,
  reportMonitor,
  writeReportJson,
} from "./reporter.js";
import type { OutputFormat, RedirectFormat } from "./types.js";

const program = new Command();

program
  .name("site-autofix")
  .description(
    "Detect and auto-fix broken links, generate redirect configs, and monitor for 500 errors"
  )
  .version("1.0.0");

// ---------------------------------------------------------------------------
// scan command
// ---------------------------------------------------------------------------

program
  .command("scan")
  .description("Crawl a site, find all internal links, and check for broken ones")
  .argument("<url>", "Root URL to scan (e.g. https://example.com)")
  .option(
    "--max-pages <number>",
    "Maximum number of pages to crawl",
    "100"
  )
  .option("--timeout <ms>", "Request timeout in milliseconds", "15000")
  .option("--concurrency <number>", "Concurrent link checks", "5")
  .option(
    "--exclude <patterns...>",
    "URL patterns to exclude (regex)"
  )
  .option(
    "--output <format>",
    "Output format: json, console, or both",
    "console"
  )
  .option("--output-file <path>", "Write JSON report to file")
  .action(async (url: string, opts) => {
    try {
      console.log(`\nScanning ${url}...\n`);

      const result = await scanSite(url, {
        maxPages: parseInt(opts.maxPages, 10),
        timeout: parseInt(opts.timeout, 10),
        concurrency: parseInt(opts.concurrency, 10),
        excludePatterns: opts.exclude ?? [],
      });

      reportScan(result, opts.output as OutputFormat);

      if (opts.outputFile) {
        writeReportJson(result, opts.outputFile);
        console.log(`\nReport written to ${opts.outputFile}`);
      }

      // Exit with code 1 if there are broken links
      if (result.brokenLinks.length > 0 || result.serverErrors.length > 0) {
        process.exit(1);
      }
    } catch (err) {
      console.error(
        "Scan failed:",
        err instanceof Error ? err.message : err
      );
      process.exit(2);
    }
  });

// ---------------------------------------------------------------------------
// fix command
// ---------------------------------------------------------------------------

program
  .command("fix")
  .description(
    "Scan for broken links, compute fixes, and generate redirect configurations"
  )
  .argument("<url>", "Root URL to scan")
  .option(
    "--target <dir>",
    "Target directory to write redirect configs",
    "."
  )
  .option(
    "--format <format>",
    "Redirect format: nextjs, netlify, nginx, or all",
    "all"
  )
  .option(
    "--min-confidence <number>",
    "Minimum confidence for a fix (0-1)",
    "0.5"
  )
  .option("--max-pages <number>", "Maximum pages to crawl", "100")
  .option("--timeout <ms>", "Request timeout in milliseconds", "15000")
  .option("--concurrency <number>", "Concurrent link checks", "5")
  .option(
    "--output <format>",
    "Output format: json, console, or both",
    "console"
  )
  .option("--output-file <path>", "Write JSON report to file")
  .action(async (url: string, opts) => {
    try {
      console.log(`\nScanning ${url} for broken links...\n`);

      const scanResult = await scanSite(url, {
        maxPages: parseInt(opts.maxPages, 10),
        timeout: parseInt(opts.timeout, 10),
        concurrency: parseInt(opts.concurrency, 10),
      });

      // Gather known-good URLs from the scan
      const knownGoodUrls = new Set<string>();
      // Pages that returned 200 are "known good"
      // We approximate this by taking all checked URLs minus the broken ones
      const brokenSet = new Set(scanResult.brokenLinks.map((l) => l.href));
      const errorSet = new Set(scanResult.serverErrors.map((l) => l.href));
      const connErrorSet = new Set(
        scanResult.connectionErrors.map((l) => l.href)
      );

      // Use the base URL and all successfully crawled page URLs
      // (We can infer these from the scan; they are URLs we visited that aren't broken)
      // For simplicity, use all scanned links that are NOT broken/errored
      for (const link of [
        ...scanResult.brokenLinks,
        ...scanResult.redirectLinks,
        ...scanResult.serverErrors,
        ...scanResult.connectionErrors,
      ]) {
        // skip
      }

      // A practical approach: the scanner visited pages, so those pages exist.
      // We don't have a direct "allVisitedPages" list, but we can reconstruct
      // from source pages of found links.
      const allSourcePages = new Set<string>();
      for (const link of [
        ...scanResult.brokenLinks,
        ...scanResult.redirectLinks,
        ...scanResult.serverErrors,
        ...scanResult.connectionErrors,
      ]) {
        if (link.sourcePage) {
          allSourcePages.add(link.sourcePage);
        }
      }

      const goodUrls = Array.from(allSourcePages);

      // Compute fixes
      const minConfidence = parseFloat(opts.minConfidence);
      const fixes = computeFixes(
        scanResult.brokenLinks,
        goodUrls,
        scanResult.redirectLinks,
        { minConfidence }
      );

      // Generate redirect entries
      const redirects = fixesToRedirects(fixes, minConfidence);

      // Write redirect configs
      const format = opts.format as string;
      let writtenPaths: string[] = [];

      if (format === "all") {
        writtenPaths = writeAllRedirectConfigs(redirects, opts.target);
      } else {
        const validFormats: RedirectFormat[] = ["nextjs", "netlify", "nginx"];
        if (validFormats.includes(format as RedirectFormat)) {
          const p = writeRedirectConfig(
            redirects,
            format as RedirectFormat,
            opts.target
          );
          writtenPaths = [p];
        } else {
          console.error(
            `Unknown format: ${format}. Use nextjs, netlify, nginx, or all.`
          );
          process.exit(2);
        }
      }

      // Report
      reportScan(scanResult, opts.output as OutputFormat);
      reportFixes(fixes, redirects, opts.output as OutputFormat);

      if (writtenPaths.length > 0) {
        console.log("\nRedirect configs written:");
        for (const p of writtenPaths) {
          console.log(`  ${p}`);
        }
      }

      if (opts.outputFile) {
        writeReportJson(
          { fixes, redirects },
          opts.outputFile
        );
        console.log(`\nReport written to ${opts.outputFile}`);
      }
    } catch (err) {
      console.error(
        "Fix failed:",
        err instanceof Error ? err.message : err
      );
      process.exit(2);
    }
  });

// ---------------------------------------------------------------------------
// monitor command
// ---------------------------------------------------------------------------

program
  .command("monitor")
  .description("Periodically check endpoints for 500-class errors")
  .argument("<url>", "Base URL to monitor (e.g. https://example.com)")
  .option(
    "--endpoints <paths...>",
    "Endpoint paths to check",
    ["/"]
  )
  .option(
    "--interval <ms>",
    "Interval between check rounds in milliseconds",
    "30000"
  )
  .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
  .option(
    "--rounds <number>",
    "Number of check rounds (default: runs indefinitely)",
    "1"
  )
  .option(
    "--output <format>",
    "Output format: json, console, or both",
    "console"
  )
  .option("--output-file <path>", "Write JSON report to file")
  .action(async (url: string, opts) => {
    try {
      const rounds = parseInt(opts.rounds, 10);
      const isIndefinite = rounds <= 0;

      console.log(`\nMonitoring ${url}...`);
      console.log(
        `  Endpoints: ${(opts.endpoints as string[]).join(", ")}`
      );
      console.log(
        `  Interval: ${opts.interval}ms | Rounds: ${isIndefinite ? "indefinite" : rounds}\n`
      );

      const report = await monitor(url, {
        endpoints: opts.endpoints as string[],
        intervalMs: parseInt(opts.interval, 10),
        timeout: parseInt(opts.timeout, 10),
        rounds: isIndefinite ? Infinity : rounds,
        onRound: (roundReport) => {
          if (roundReport.failures.length > 0) {
            reportMonitor(roundReport, opts.output as OutputFormat);
          }
        },
      });

      reportMonitor(report, opts.output as OutputFormat);

      if (opts.outputFile) {
        writeReportJson(report, opts.outputFile);
        console.log(`\nReport written to ${opts.outputFile}`);
      }

      // Exit with code 1 if there were failures
      if (report.failures.length > 0) {
        process.exit(1);
      }
    } catch (err) {
      console.error(
        "Monitor failed:",
        err instanceof Error ? err.message : err
      );
      process.exit(2);
    }
  });

// ---------------------------------------------------------------------------
// Parse and run
// ---------------------------------------------------------------------------

program.parse();
