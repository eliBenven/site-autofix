import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reportScan,
  reportFixes,
  reportMonitor,
  writeReportJson,
} from "../src/reporter.js";
import type {
  ScanResult,
  LinkFix,
  RedirectEntry,
  MonitorReport,
} from "../src/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    baseUrl: "https://example.com",
    totalLinks: 10,
    pagesCrawled: 5,
    brokenLinks: [],
    redirectLinks: [],
    serverErrors: [],
    connectionErrors: [],
    timestamp: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMonitorReport(
  overrides: Partial<MonitorReport> = {}
): MonitorReport {
  return {
    baseUrl: "https://example.com",
    endpoints: [],
    failures: [],
    remediations: [],
    timestamp: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reporter", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Console output format
  // -----------------------------------------------------------------------
  describe("console output format", () => {
    it("should output scan report to console", () => {
      const result = makeScanResult({
        brokenLinks: [
          {
            sourcePage: "https://example.com/",
            href: "https://example.com/missing",
            resolvedUrl: "https://example.com/missing",
            statusCode: 404,
            isRedirect: false,
            finalUrl: null,
            redirectChain: [],
            error: null,
          },
        ],
      });

      reportScan(result, "console");

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls
        .map((call) => String(call[0]))
        .join("\n");
      expect(output).toContain("Site Scan Report");
      expect(output).toContain("https://example.com");
      expect(output).toContain("404");
    });

    it("should output a clean report when there are no issues", () => {
      reportScan(makeScanResult(), "console");

      const output = consoleSpy.mock.calls
        .map((call) => String(call[0]))
        .join("\n");
      expect(output).toContain("No broken links found");
      expect(output).toContain("All links healthy");
    });

    it("should output fix report to console", () => {
      const fixes: LinkFix[] = [
        {
          originalHref: "https://example.com/old",
          suggestedHref: "https://example.com/new",
          confidence: 0.9,
          method: "redirect-target",
          sourcePages: ["https://example.com/"],
        },
      ];
      const redirects: RedirectEntry[] = [
        { from: "/old", to: "/new", statusCode: 301 },
      ];

      reportFixes(fixes, redirects, "console");

      const output = consoleSpy.mock.calls
        .map((call) => String(call[0]))
        .join("\n");
      expect(output).toContain("Link Fix Report");
      expect(output).toContain("/old");
      expect(output).toContain("/new");
    });

    it("should output monitor report to console", () => {
      const report = makeMonitorReport({
        endpoints: [
          {
            url: "https://example.com/",
            statusCode: 200,
            responseTimeMs: 100,
            headers: {},
            bodySnippet: null,
            stackTrace: null,
            timestamp: "2025-01-01T00:00:00.000Z",
            healthy: true,
            errorClass: null,
          },
        ],
      });

      reportMonitor(report, "console");

      const output = consoleSpy.mock.calls
        .map((call) => String(call[0]))
        .join("\n");
      expect(output).toContain("Health Monitor Report");
      expect(output).toContain("https://example.com");
    });

    it("should display error classifications and remediations", () => {
      const report = makeMonitorReport({
        endpoints: [
          {
            url: "https://example.com/api",
            statusCode: 500,
            responseTimeMs: 100,
            headers: {},
            bodySnippet: "Internal Server Error",
            stackTrace: null,
            timestamp: "2025-01-01T00:00:00.000Z",
            healthy: false,
            errorClass: "database-error",
          },
        ],
        failures: [
          {
            url: "https://example.com/api",
            statusCode: 500,
            responseTimeMs: 100,
            headers: {},
            bodySnippet: "Internal Server Error",
            stackTrace: null,
            timestamp: "2025-01-01T00:00:00.000Z",
            healthy: false,
            errorClass: "database-error",
          },
        ],
        remediations: [
          {
            type: "restart",
            description: "Database connection error.",
            autoApplicable: true,
            triggeredBy: "database-error",
          },
        ],
      });

      reportMonitor(report, "console");

      const output = consoleSpy.mock.calls
        .map((call) => String(call[0]))
        .join("\n");
      expect(output).toContain("FAIL");
      expect(output).toContain("database-error");
      expect(output).toContain("Recommended actions");
      expect(output).toContain("restart");
    });
  });

  // -----------------------------------------------------------------------
  // JSON report structure
  // -----------------------------------------------------------------------
  describe("JSON report structure", () => {
    it("should output valid JSON for scan report", () => {
      const result = makeScanResult();

      reportScan(result, "json");

      expect(consoleSpy).toHaveBeenCalled();
      const jsonOutput = consoleSpy.mock.calls
        .map((call) => String(call[0]))
        .join("");
      const parsed = JSON.parse(jsonOutput);
      expect(parsed.baseUrl).toBe("https://example.com");
      expect(parsed.totalLinks).toBe(10);
      expect(parsed.pagesCrawled).toBe(5);
      expect(Array.isArray(parsed.brokenLinks)).toBe(true);
      expect(Array.isArray(parsed.redirectLinks)).toBe(true);
      expect(Array.isArray(parsed.serverErrors)).toBe(true);
      expect(Array.isArray(parsed.connectionErrors)).toBe(true);
      expect(parsed.timestamp).toBe("2025-01-01T00:00:00.000Z");
    });

    it("should output valid JSON for fix report", () => {
      const fixes: LinkFix[] = [
        {
          originalHref: "/old",
          suggestedHref: "/new",
          confidence: 0.85,
          method: "fuzzy-match",
          sourcePages: [],
        },
      ];
      const redirects: RedirectEntry[] = [
        { from: "/old", to: "/new", statusCode: 301 },
      ];

      reportFixes(fixes, redirects, "json");

      const jsonOutput = consoleSpy.mock.calls
        .map((call) => String(call[0]))
        .join("");
      const parsed = JSON.parse(jsonOutput);
      expect(Array.isArray(parsed.fixes)).toBe(true);
      expect(parsed.fixes[0].originalHref).toBe("/old");
      expect(Array.isArray(parsed.redirects)).toBe(true);
      expect(parsed.redirects[0].statusCode).toBe(301);
    });

    it("should output valid JSON for monitor report", () => {
      const report = makeMonitorReport({
        endpoints: [
          {
            url: "https://example.com/",
            statusCode: 200,
            responseTimeMs: 50,
            headers: {},
            bodySnippet: null,
            stackTrace: null,
            timestamp: "2025-01-01T00:00:00.000Z",
            healthy: true,
            errorClass: null,
          },
        ],
      });

      reportMonitor(report, "json");

      const jsonOutput = consoleSpy.mock.calls
        .map((call) => String(call[0]))
        .join("");
      const parsed = JSON.parse(jsonOutput);
      expect(parsed.baseUrl).toBe("https://example.com");
      expect(Array.isArray(parsed.endpoints)).toBe(true);
      expect(parsed.endpoints[0].healthy).toBe(true);
    });

    it("should write JSON report to file", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reporter-test-"));
      const outputPath = path.join(tmpDir, "report.json");
      const data = makeScanResult();

      writeReportJson(data, outputPath);

      const written = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      expect(written.baseUrl).toBe("https://example.com");
      expect(written.totalLinks).toBe(10);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });
    });
  });
});
