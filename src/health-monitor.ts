/**
 * health-monitor.ts
 *
 * Performs periodic synthetic health checks against endpoints,
 * detects 500-class errors, collects response metadata and stack traces,
 * classifies error patterns, and recommends remediation actions.
 */

import type {
  ErrorClass,
  HealthCheckResult,
  MonitorReport,
  RemediationAction,
} from "./types.js";

/** Options for the health monitor. */
export interface MonitorOptions {
  /** Interval between checks in milliseconds. Default: 30000 (30s). */
  intervalMs?: number;
  /** Request timeout in milliseconds. Default: 10000. */
  timeout?: number;
  /** Number of check rounds to perform. Default: Infinity (run until stopped). */
  rounds?: number;
  /** Specific endpoint paths to check (appended to baseUrl). Default: ["/"]. */
  endpoints?: string[];
  /** Callback invoked after each check round. */
  onRound?: (report: MonitorReport) => void;
}

const DEFAULT_OPTIONS: Required<Omit<MonitorOptions, "onRound">> = {
  intervalMs: 30000,
  timeout: 10000,
  rounds: Infinity,
  endpoints: ["/"],
};

/**
 * Classify a 500-class error based on response body and headers.
 */
export function classifyError(
  statusCode: number | null,
  body: string | null,
  headers: Record<string, string>,
  responseTimeMs: number
): ErrorClass {
  if (statusCode === null || responseTimeMs >= 10000) {
    return "timeout";
  }

  const bodyLower = (body ?? "").toLowerCase();

  // Out of memory patterns
  if (
    bodyLower.includes("out of memory") ||
    bodyLower.includes("heap") ||
    bodyLower.includes("oom") ||
    bodyLower.includes("memory limit")
  ) {
    return "oom";
  }

  // Database error patterns
  if (
    bodyLower.includes("database") ||
    bodyLower.includes("sql") ||
    bodyLower.includes("connection refused") ||
    bodyLower.includes("econnrefused") ||
    bodyLower.includes("pool") ||
    bodyLower.includes("postgres") ||
    bodyLower.includes("mysql") ||
    bodyLower.includes("mongo")
  ) {
    return "database-error";
  }

  // Upstream/dependency error patterns
  if (
    bodyLower.includes("upstream") ||
    bodyLower.includes("gateway") ||
    bodyLower.includes("proxy") ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504
  ) {
    return "upstream-dependency";
  }

  // Configuration error patterns
  if (
    bodyLower.includes("configuration") ||
    bodyLower.includes("config") ||
    bodyLower.includes("env") ||
    bodyLower.includes("missing key") ||
    bodyLower.includes("undefined") ||
    bodyLower.includes("not configured")
  ) {
    return "configuration-error";
  }

  // Unhandled exception patterns (stack traces, etc.)
  if (
    bodyLower.includes("error") ||
    bodyLower.includes("exception") ||
    bodyLower.includes("stack") ||
    bodyLower.includes("at ") ||
    bodyLower.includes("traceback")
  ) {
    return "unhandled-exception";
  }

  return "unknown";
}

/**
 * Extract a stack trace from response body, if present.
 */
export function extractStackTrace(body: string | null): string | null {
  if (!body) return null;

  // Look for common stack trace patterns
  const patterns = [
    // Node.js / JavaScript
    /(?:Error|TypeError|ReferenceError|SyntaxError)[^\n]*\n(?:\s+at\s+.+\n?)+/g,
    // Python
    /Traceback \(most recent call last\):[\s\S]*?(?:\w+Error|Exception):[^\n]*/g,
    // Java / JVM
    /(?:\w+\.)+\w+(?:Error|Exception)[^\n]*(?:\n\s+at\s+[\w.$]+\([^)]*\))+/g,
    // Ruby
    /(?:[^\n]*\.rb:\d+:in[^\n]*\n?)+/g,
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) {
      return match[0]!;
    }
  }

  return null;
}

/**
 * Recommend remediation actions based on error classification.
 */
export function recommendRemediation(
  errorClass: ErrorClass
): RemediationAction {
  switch (errorClass) {
    case "timeout":
      return {
        type: "restart",
        description:
          "Endpoint is timing out. Consider restarting the service or scaling up resources.",
        autoApplicable: true,
        triggeredBy: errorClass,
      };

    case "oom":
      return {
        type: "restart",
        description:
          "Out of memory detected. Restart the service and investigate memory leaks.",
        autoApplicable: true,
        triggeredBy: errorClass,
      };

    case "database-error":
      return {
        type: "restart",
        description:
          "Database connection error. Check database availability and restart connection pools.",
        autoApplicable: true,
        triggeredBy: errorClass,
      };

    case "upstream-dependency":
      return {
        type: "open-issue",
        description:
          "Upstream dependency failure. Check status of dependent services.",
        autoApplicable: false,
        triggeredBy: errorClass,
      };

    case "configuration-error":
      return {
        type: "rollback",
        description:
          "Configuration error detected. Consider rolling back to the last known good deployment.",
        autoApplicable: true,
        triggeredBy: errorClass,
      };

    case "unhandled-exception":
      return {
        type: "feature-flag-off",
        description:
          "Unhandled exception detected. Disable the affected feature flag if applicable, or rollback.",
        autoApplicable: true,
        triggeredBy: errorClass,
      };

    case "unknown":
      return {
        type: "open-issue",
        description:
          "Unknown error pattern. Opening issue with full repro artifacts for manual investigation.",
        autoApplicable: false,
        triggeredBy: errorClass,
      };
  }
}

/**
 * Perform a single health check against a URL.
 */
export async function checkEndpoint(
  url: string,
  timeout: number
): Promise<HealthCheckResult> {
  const startTime = Date.now();
  let statusCode: number | null = null;
  let headers: Record<string, string> = {};
  let bodySnippet: string | null = null;
  let stackTrace: string | null = null;
  let healthy = false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "site-autofix/1.0 (health-monitor)",
      },
    });

    clearTimeout(timeoutId);
    statusCode = response.status;
    healthy = statusCode >= 200 && statusCode < 300;

    // Collect selected response headers
    const headerNames = [
      "content-type",
      "server",
      "x-request-id",
      "x-trace-id",
      "retry-after",
      "x-ratelimit-remaining",
    ];
    for (const name of headerNames) {
      const value = response.headers.get(name);
      if (value) {
        headers[name] = value;
      }
    }

    // Collect body for error responses
    if (!healthy) {
      const text = await response.text();
      bodySnippet = text.slice(0, 2000);
      stackTrace = extractStackTrace(text);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bodySnippet = message;
  }

  const responseTimeMs = Date.now() - startTime;
  const errorClass = !healthy
    ? classifyError(statusCode, bodySnippet, headers, responseTimeMs)
    : null;

  return {
    url,
    statusCode,
    responseTimeMs,
    headers,
    bodySnippet: healthy ? null : bodySnippet,
    stackTrace,
    timestamp: new Date().toISOString(),
    healthy,
    errorClass,
  };
}

/**
 * Run the health monitor.
 *
 * Performs periodic health checks against the specified base URL and endpoints.
 * Returns the final aggregated report. If options.rounds is Infinity, this
 * runs until the returned AbortController is signaled.
 */
export async function monitor(
  baseUrl: string,
  options: MonitorOptions = {}
): Promise<MonitorReport> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const normalizedBase = baseUrl.replace(/\/$/, "");

  const allResults: HealthCheckResult[] = [];
  const allRemediations: RemediationAction[] = [];

  for (let round = 0; round < opts.rounds; round++) {
    if (round > 0) {
      await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
    }

    process.stderr.write(
      `\n  [Round ${round + 1}] Checking ${opts.endpoints.length} endpoint(s)...\n`
    );

    const roundResults: HealthCheckResult[] = [];

    for (const endpoint of opts.endpoints) {
      const url = `${normalizedBase}${endpoint}`;
      const result = await checkEndpoint(url, opts.timeout);
      roundResults.push(result);

      const statusDisplay = result.statusCode ?? "ERR";
      const icon = result.healthy ? "OK" : "FAIL";
      process.stderr.write(
        `    [${icon}] ${url} -> ${statusDisplay} (${result.responseTimeMs}ms)\n`
      );

      if (!result.healthy && result.errorClass) {
        const remediation = recommendRemediation(result.errorClass);
        process.stderr.write(
          `    Classification: ${result.errorClass}\n` +
            `    Recommendation: ${remediation.description}\n`
        );
        allRemediations.push(remediation);
      }
    }

    allResults.push(...roundResults);

    const roundReport: MonitorReport = {
      baseUrl,
      endpoints: roundResults,
      failures: roundResults.filter((r) => !r.healthy),
      remediations: allRemediations,
      timestamp: new Date().toISOString(),
    };

    if (opts.onRound) {
      opts.onRound(roundReport);
    }
  }

  return {
    baseUrl,
    endpoints: allResults,
    failures: allResults.filter((r) => !r.healthy),
    remediations: allRemediations,
    timestamp: new Date().toISOString(),
  };
}
