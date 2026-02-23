/**
 * reporter.ts
 *
 * Produces human-readable console output and machine-readable JSON reports
 * for scan results, fix results, and monitor reports.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  LinkFix,
  MonitorReport,
  OutputFormat,
  RedirectEntry,
  ScanResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Console formatting helpers
// ---------------------------------------------------------------------------

const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function heading(text: string): string {
  return `\n${BOLD}${CYAN}${text}${RESET}\n${"=".repeat(text.length)}\n`;
}

function success(text: string): string {
  return `${GREEN}${text}${RESET}`;
}

function warning(text: string): string {
  return `${YELLOW}${text}${RESET}`;
}

function error(text: string): string {
  return `${RED}${text}${RESET}`;
}

function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

// ---------------------------------------------------------------------------
// Scan report
// ---------------------------------------------------------------------------

function formatScanConsole(result: ScanResult): string {
  const lines: string[] = [];

  lines.push(heading("Site Scan Report"));
  lines.push(`Base URL:       ${result.baseUrl}`);
  lines.push(`Pages crawled:  ${result.pagesCrawled}`);
  lines.push(`Total links:    ${result.totalLinks}`);
  lines.push(`Scan time:      ${result.timestamp}`);
  lines.push("");

  // Broken links (404)
  if (result.brokenLinks.length > 0) {
    lines.push(error(`  Broken links (404): ${result.brokenLinks.length}`));
    for (const link of result.brokenLinks) {
      lines.push(`    ${error("404")} ${link.href}`);
      lines.push(`         ${dim(`Found on: ${link.sourcePage}`)}`);
    }
    lines.push("");
  } else {
    lines.push(success("  No broken links found."));
    lines.push("");
  }

  // Redirect chains
  if (result.redirectLinks.length > 0) {
    lines.push(
      warning(`  Redirect chains: ${result.redirectLinks.length}`)
    );
    for (const link of result.redirectLinks) {
      const chain = [...link.redirectChain, link.finalUrl ?? link.href].join(
        " -> "
      );
      lines.push(`    ${warning("3xx")} ${chain}`);
      lines.push(`         ${dim(`Found on: ${link.sourcePage}`)}`);
    }
    lines.push("");
  }

  // Server errors
  if (result.serverErrors.length > 0) {
    lines.push(error(`  Server errors (5xx): ${result.serverErrors.length}`));
    for (const link of result.serverErrors) {
      lines.push(`    ${error(String(link.statusCode))} ${link.href}`);
    }
    lines.push("");
  }

  // Connection errors
  if (result.connectionErrors.length > 0) {
    lines.push(
      error(`  Connection errors: ${result.connectionErrors.length}`)
    );
    for (const link of result.connectionErrors) {
      lines.push(`    ${error("ERR")} ${link.href}`);
      lines.push(`         ${dim(link.error ?? "Unknown error")}`);
    }
    lines.push("");
  }

  // Summary
  const totalIssues =
    result.brokenLinks.length +
    result.serverErrors.length +
    result.connectionErrors.length;
  if (totalIssues === 0) {
    lines.push(success("  All links healthy."));
  } else {
    lines.push(error(`  Total issues: ${totalIssues}`));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fix report
// ---------------------------------------------------------------------------

function formatFixConsole(
  fixes: LinkFix[],
  redirects: RedirectEntry[]
): string {
  const lines: string[] = [];

  lines.push(heading("Link Fix Report"));

  if (fixes.length === 0) {
    lines.push("  No fixes to suggest.");
    return lines.join("\n");
  }

  lines.push(`  Fixes proposed: ${fixes.length}`);
  lines.push(`  Redirects generated: ${redirects.length}`);
  lines.push("");

  for (const fix of fixes) {
    const confidencePct = Math.round(fix.confidence * 100);
    const confidenceColor =
      confidencePct >= 80 ? GREEN : confidencePct >= 60 ? YELLOW : RED;
    lines.push(
      `  ${fix.originalHref}` +
        `  ->  ${fix.suggestedHref}` +
        `  ${confidenceColor}[${confidencePct}% ${fix.method}]${RESET}`
    );
    if (fix.sourcePages.length > 0) {
      lines.push(
        `       ${dim(`Referenced from: ${fix.sourcePages.join(", ")}`)}`
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Monitor report
// ---------------------------------------------------------------------------

function formatMonitorConsole(report: MonitorReport): string {
  const lines: string[] = [];

  lines.push(heading("Health Monitor Report"));
  lines.push(`Base URL:    ${report.baseUrl}`);
  lines.push(`Checked:     ${report.endpoints.length} endpoint(s)`);
  lines.push(`Failures:    ${report.failures.length}`);
  lines.push(`Timestamp:   ${report.timestamp}`);
  lines.push("");

  for (const ep of report.endpoints) {
    const icon = ep.healthy ? success("OK  ") : error("FAIL");
    const status = ep.statusCode ?? "ERR";
    lines.push(`  [${icon}] ${ep.url}  ${status}  ${ep.responseTimeMs}ms`);

    if (!ep.healthy) {
      if (ep.errorClass) {
        lines.push(`         Classification: ${warning(ep.errorClass)}`);
      }
      if (ep.stackTrace) {
        const truncated =
          ep.stackTrace.length > 200
            ? ep.stackTrace.slice(0, 200) + "..."
            : ep.stackTrace;
        lines.push(`         Stack trace: ${dim(truncated)}`);
      }
    }
  }

  if (report.remediations.length > 0) {
    lines.push("");
    lines.push(`  ${BOLD}Recommended actions:${RESET}`);
    const seen = new Set<string>();
    for (const rem of report.remediations) {
      const key = `${rem.type}:${rem.triggeredBy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const autoTag = rem.autoApplicable
        ? success("[auto-applicable]")
        : warning("[manual]");
      lines.push(
        `    ${autoTag} [${rem.type}] ${rem.description}`
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Report a scan result. */
export function reportScan(
  result: ScanResult,
  format: OutputFormat = "both"
): void {
  if (format === "console" || format === "both") {
    console.log(formatScanConsole(result));
  }
  if (format === "json" || format === "both") {
    console.log(JSON.stringify(result, null, 2));
  }
}

/** Report link fixes. */
export function reportFixes(
  fixes: LinkFix[],
  redirects: RedirectEntry[],
  format: OutputFormat = "both"
): void {
  if (format === "console" || format === "both") {
    console.log(formatFixConsole(fixes, redirects));
  }
  if (format === "json" || format === "both") {
    console.log(JSON.stringify({ fixes, redirects }, null, 2));
  }
}

/** Report health monitoring results. */
export function reportMonitor(
  report: MonitorReport,
  format: OutputFormat = "both"
): void {
  if (format === "console" || format === "both") {
    console.log(formatMonitorConsole(report));
  }
  if (format === "json" || format === "both") {
    console.log(JSON.stringify(report, null, 2));
  }
}

/** Write a report to a JSON file. */
export function writeReportJson(
  data: ScanResult | MonitorReport | { fixes: LinkFix[]; redirects: RedirectEntry[] },
  outputPath: string
): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf-8");
}
