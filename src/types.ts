/**
 * Shared type definitions for site-autofix.
 */

/** Result of checking a single link. */
export interface LinkCheckResult {
  /** The source page where this link was found. */
  sourcePage: string;
  /** The href value from the anchor tag. */
  href: string;
  /** Fully resolved URL. */
  resolvedUrl: string;
  /** HTTP status code returned, or null if the request failed entirely. */
  statusCode: number | null;
  /** Whether this link redirected (3xx). */
  isRedirect: boolean;
  /** The final URL after following redirects, if applicable. */
  finalUrl: string | null;
  /** The full redirect chain, if applicable. */
  redirectChain: string[];
  /** Error message if the request failed. */
  error: string | null;
}

/** Summary of a full site scan. */
export interface ScanResult {
  /** The root URL that was scanned. */
  baseUrl: string;
  /** Total number of internal links checked. */
  totalLinks: number;
  /** Total number of unique pages crawled. */
  pagesCrawled: number;
  /** Links that returned 404. */
  brokenLinks: LinkCheckResult[];
  /** Links that involved redirects (3xx). */
  redirectLinks: LinkCheckResult[];
  /** Links that returned server errors (5xx). */
  serverErrors: LinkCheckResult[];
  /** Links that failed to connect. */
  connectionErrors: LinkCheckResult[];
  /** Timestamp of the scan. */
  timestamp: string;
}

/** A proposed fix for a broken link. */
export interface LinkFix {
  /** The original broken href. */
  originalHref: string;
  /** The proposed replacement href. */
  suggestedHref: string;
  /** Confidence score 0-1 for the suggestion. */
  confidence: number;
  /** How the fix was determined: fuzzy match, redirect target, etc. */
  method: "fuzzy-match" | "redirect-target" | "path-similarity" | "manual";
  /** Source pages that reference this broken link. */
  sourcePages: string[];
}

/** A redirect map entry. */
export interface RedirectEntry {
  /** The old path (source). */
  from: string;
  /** The new path (destination). */
  to: string;
  /** HTTP status code for the redirect (301 or 302). */
  statusCode: 301 | 302;
}

/** Supported redirect config formats. */
export type RedirectFormat = "nextjs" | "netlify" | "nginx";

/** Result of a health check on a single endpoint. */
export interface HealthCheckResult {
  /** The URL that was checked. */
  url: string;
  /** HTTP status code, or null if connection failed. */
  statusCode: number | null;
  /** Response time in milliseconds. */
  responseTimeMs: number;
  /** Response headers (selected). */
  headers: Record<string, string>;
  /** Response body snippet (first 2000 chars) if error. */
  bodySnippet: string | null;
  /** Extracted stack trace, if any. */
  stackTrace: string | null;
  /** Timestamp of the check. */
  timestamp: string;
  /** Whether the check passed (2xx). */
  healthy: boolean;
  /** Error classification if unhealthy. */
  errorClass: ErrorClass | null;
}

/** Classification of a 500-type error. */
export type ErrorClass =
  | "timeout"
  | "oom"
  | "unhandled-exception"
  | "database-error"
  | "upstream-dependency"
  | "configuration-error"
  | "unknown";

/** Recommended remediation action. */
export interface RemediationAction {
  /** The type of action to take. */
  type: "restart" | "rollback" | "feature-flag-off" | "open-issue";
  /** Human-readable description of what to do. */
  description: string;
  /** Whether this action can be applied automatically. */
  autoApplicable: boolean;
  /** The error class that triggered this recommendation. */
  triggeredBy: ErrorClass;
}

/** Full monitoring report. */
export interface MonitorReport {
  /** The base URL being monitored. */
  baseUrl: string;
  /** All endpoints checked. */
  endpoints: HealthCheckResult[];
  /** Unhealthy endpoints. */
  failures: HealthCheckResult[];
  /** Recommended remediations. */
  remediations: RemediationAction[];
  /** Timestamp. */
  timestamp: string;
}

/** Output format for the reporter. */
export type OutputFormat = "json" | "console" | "both";
