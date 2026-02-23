/**
 * link-scanner.ts
 *
 * Crawls a website starting from a root URL, discovers all internal links,
 * checks their HTTP status codes, and identifies broken links (404s),
 * redirect chains, and server errors.
 */

import { chromium, type Browser, type Page } from "playwright";
import type { LinkCheckResult, ScanResult } from "./types.js";

/** Options for the link scanner. */
export interface ScanOptions {
  /** Maximum number of pages to crawl. Default: 100. */
  maxPages?: number;
  /** Request timeout in milliseconds. Default: 15000. */
  timeout?: number;
  /** Whether to follow and record redirect chains. Default: true. */
  followRedirects?: boolean;
  /** Concurrency limit for checking links. Default: 5. */
  concurrency?: number;
  /** Additional URL patterns to exclude (regex strings). */
  excludePatterns?: string[];
}

const DEFAULT_OPTIONS: Required<ScanOptions> = {
  maxPages: 100,
  timeout: 15000,
  followRedirects: true,
  concurrency: 5,
  excludePatterns: [],
};

/**
 * Normalize a URL by removing trailing slashes, fragments, and query params
 * for deduplication purposes.
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    // Keep query params as they may serve different content
    let normalized = parsed.toString();
    if (normalized.endsWith("/") && parsed.pathname !== "/") {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url;
  }
}

/**
 * Check if a URL is internal (same origin) relative to the base URL.
 */
function isInternalUrl(url: string, baseOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === baseOrigin;
  } catch {
    return false;
  }
}

/**
 * Check a single URL and return its status, following redirects.
 */
async function checkUrl(
  url: string,
  timeout: number,
  followRedirects: boolean
): Promise<{ statusCode: number | null; finalUrl: string | null; redirectChain: string[]; error: string | null }> {
  const redirectChain: string[] = [];
  let currentUrl = url;

  try {
    const maxRedirects = followRedirects ? 10 : 0;
    for (let i = 0; i <= maxRedirects; i++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": "site-autofix/1.0 (link-checker)",
          },
        });

        clearTimeout(timeoutId);
        const status = response.status;

        if (status >= 300 && status < 400 && followRedirects) {
          const location = response.headers.get("location");
          if (location) {
            redirectChain.push(currentUrl);
            currentUrl = new URL(location, currentUrl).toString();
            continue;
          }
        }

        return {
          statusCode: status,
          finalUrl: redirectChain.length > 0 ? currentUrl : null,
          redirectChain,
          error: null,
        };
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    }

    return {
      statusCode: null,
      finalUrl: currentUrl,
      redirectChain,
      error: "Too many redirects",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      statusCode: null,
      finalUrl: null,
      redirectChain,
      error: message,
    };
  }
}

/**
 * Extract all internal links from a page using Playwright.
 */
async function extractLinks(page: Page, baseOrigin: string): Promise<string[]> {
  // Use page.locator to extract href attributes from all anchor elements.
  // This avoids needing DOM types in our TypeScript config.
  const anchors = page.locator("a[href]");
  const count = await anchors.count();
  const hrefs: string[] = [];
  for (let i = 0; i < count; i++) {
    const href = await anchors.nth(i).getAttribute("href");
    if (href) {
      try {
        // Resolve relative URLs against the page URL
        const pageUrl = page.url();
        const resolved = new URL(href, pageUrl).toString();
        hrefs.push(resolved);
      } catch {
        // Skip malformed URLs
      }
    }
  }

  return hrefs
    .filter((href) => isInternalUrl(href, baseOrigin))
    .map((href) => normalizeUrl(href));
}

/**
 * Run items through an async function with bounded concurrency.
 */
async function asyncPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const p = fn(item).then((result) => {
      results.push(result);
    });
    const wrapped = p.then(() => {
      executing.delete(wrapped);
    });
    executing.add(wrapped);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

/**
 * Scan a website for broken links.
 *
 * Crawls the site starting from `rootUrl`, extracts all internal links,
 * checks each link's status code, and returns a comprehensive scan result.
 */
export async function scanSite(
  rootUrl: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const baseOrigin = new URL(rootUrl).origin;
  const excludeRegexes = opts.excludePatterns.map((p) => new RegExp(p));

  const visited = new Set<string>();
  const toVisit: string[] = [normalizeUrl(rootUrl)];
  const allLinks = new Map<string, Set<string>>(); // href -> set of source pages

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "site-autofix/1.0 (crawler)",
    });

    // Phase 1: Crawl pages and collect links
    while (toVisit.length > 0 && visited.size < opts.maxPages) {
      const url = toVisit.shift()!;
      if (visited.has(url)) continue;
      if (excludeRegexes.some((r) => r.test(url))) continue;

      visited.add(url);
      process.stderr.write(`  Crawling: ${url}\n`);

      try {
        const page = await context.newPage();
        await page.goto(url, {
          timeout: opts.timeout,
          waitUntil: "domcontentloaded",
        });

        const links = await extractLinks(page, baseOrigin);
        for (const link of links) {
          if (!allLinks.has(link)) {
            allLinks.set(link, new Set());
          }
          allLinks.get(link)!.add(url);

          if (!visited.has(link) && !toVisit.includes(link)) {
            toVisit.push(link);
          }
        }

        await page.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  Error crawling ${url}: ${message}\n`);
      }
    }

    await context.close();
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  // Phase 2: Check all discovered links
  process.stderr.write(`\n  Checking ${allLinks.size} unique links...\n`);

  const linkEntries = Array.from(allLinks.entries());
  const results: LinkCheckResult[] = [];

  await asyncPool(linkEntries, opts.concurrency, async ([href, sourcePages]) => {
    const check = await checkUrl(href, opts.timeout, opts.followRedirects);
    const result: LinkCheckResult = {
      sourcePage: Array.from(sourcePages)[0]!,
      href,
      resolvedUrl: href,
      statusCode: check.statusCode,
      isRedirect: check.redirectChain.length > 0,
      finalUrl: check.finalUrl,
      redirectChain: check.redirectChain,
      error: check.error,
    };
    results.push(result);
  });

  const brokenLinks = results.filter((r) => r.statusCode === 404);
  const redirectLinks = results.filter((r) => r.isRedirect);
  const serverErrors = results.filter(
    (r) => r.statusCode !== null && r.statusCode >= 500
  );
  const connectionErrors = results.filter(
    (r) => r.statusCode === null && r.error !== null
  );

  return {
    baseUrl: rootUrl,
    totalLinks: results.length,
    pagesCrawled: visited.size,
    brokenLinks,
    redirectLinks,
    serverErrors,
    connectionErrors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Quick scan that checks a list of known URLs without crawling.
 * Useful when you already know which URLs to check.
 */
export async function checkUrls(
  urls: string[],
  options: Pick<ScanOptions, "timeout" | "concurrency" | "followRedirects"> = {}
): Promise<LinkCheckResult[]> {
  const timeout = options.timeout ?? DEFAULT_OPTIONS.timeout;
  const concurrency = options.concurrency ?? DEFAULT_OPTIONS.concurrency;
  const followRedirects = options.followRedirects ?? DEFAULT_OPTIONS.followRedirects;

  return asyncPool(urls, concurrency, async (url) => {
    const check = await checkUrl(url, timeout, followRedirects);
    return {
      sourcePage: "",
      href: url,
      resolvedUrl: url,
      statusCode: check.statusCode,
      isRedirect: check.redirectChain.length > 0,
      finalUrl: check.finalUrl,
      redirectChain: check.redirectChain,
      error: check.error,
    };
  });
}
