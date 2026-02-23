/**
 * link-fixer.ts
 *
 * Given a set of broken links and a set of known-good pages,
 * compute suggested fixes using fuzzy matching, redirect targets,
 * and path similarity heuristics. Also generates redirect map entries.
 */

import type { LinkCheckResult, LinkFix, RedirectEntry } from "./types.js";

/**
 * Compute the Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          matrix[i]![j - 1]! + 1, // insertion
          matrix[i - 1]![j]! + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length]![a.length]!;
}

/**
 * Extract path segments from a URL for comparison.
 */
function pathSegments(url: string): string[] {
  try {
    const parsed = new URL(url);
    return parsed.pathname
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => s.toLowerCase());
  } catch {
    return url
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => s.toLowerCase());
  }
}

/**
 * Compute similarity between two URL paths (0 to 1, where 1 = identical).
 */
function pathSimilarity(urlA: string, urlB: string): number {
  const segA = pathSegments(urlA);
  const segB = pathSegments(urlB);

  if (segA.length === 0 && segB.length === 0) return 1;
  if (segA.length === 0 || segB.length === 0) return 0;

  // Count matching segments
  const maxLen = Math.max(segA.length, segB.length);
  let matches = 0;

  for (const seg of segA) {
    if (segB.includes(seg)) {
      matches++;
    }
  }

  // Also factor in the string-level edit distance of the full path
  const pathA = segA.join("/");
  const pathB = segB.join("/");
  const maxPathLen = Math.max(pathA.length, pathB.length);
  const editDistance = levenshtein(pathA, pathB);
  const editSimilarity = maxPathLen > 0 ? 1 - editDistance / maxPathLen : 1;

  // Weighted combination: segment overlap + edit distance
  const segmentSimilarity = matches / maxLen;
  return segmentSimilarity * 0.6 + editSimilarity * 0.4;
}

/**
 * Extract the pathname from a URL.
 */
function getPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Options for computing link fixes. */
export interface FixOptions {
  /** Minimum confidence threshold to include a suggestion. Default: 0.4. */
  minConfidence?: number;
  /** Maximum number of suggestions per broken link. Default: 1. */
  maxSuggestions?: number;
}

/**
 * Given broken links and a list of known-good URLs, compute fix suggestions.
 */
export function computeFixes(
  brokenLinks: LinkCheckResult[],
  knownGoodUrls: string[],
  redirectLinks: LinkCheckResult[],
  options: FixOptions = {}
): LinkFix[] {
  const minConfidence = options.minConfidence ?? 0.4;
  const fixes: LinkFix[] = [];

  // Build a map of broken URLs to their source pages
  const brokenByUrl = new Map<string, string[]>();
  for (const link of brokenLinks) {
    const existing = brokenByUrl.get(link.href) ?? [];
    existing.push(link.sourcePage);
    brokenByUrl.set(link.href, existing);
  }

  // Build a redirect target map for broken links that had redirect info
  const redirectTargets = new Map<string, string>();
  for (const link of redirectLinks) {
    if (link.finalUrl) {
      redirectTargets.set(link.href, link.finalUrl);
    }
  }

  for (const [brokenUrl, sourcePages] of brokenByUrl.entries()) {
    // Strategy 1: Check if this URL has a known redirect target
    const redirectTarget = redirectTargets.get(brokenUrl);
    if (redirectTarget) {
      const confidence = 0.95;
      if (confidence >= minConfidence) {
        fixes.push({
          originalHref: brokenUrl,
          suggestedHref: redirectTarget,
          confidence,
          method: "redirect-target",
          sourcePages,
        });
        continue;
      }
    }

    // Strategy 2: Fuzzy match against known-good URLs
    let bestMatch: { url: string; score: number } | null = null;

    for (const goodUrl of knownGoodUrls) {
      const score = pathSimilarity(brokenUrl, goodUrl);
      if (score > (bestMatch?.score ?? 0)) {
        bestMatch = { url: goodUrl, score };
      }
    }

    if (bestMatch && bestMatch.score >= minConfidence) {
      // Determine method based on what made the match
      const brokenSegs = pathSegments(brokenUrl);
      const matchSegs = pathSegments(bestMatch.url);
      const segOverlap = brokenSegs.filter((s) => matchSegs.includes(s)).length;
      const method: LinkFix["method"] =
        segOverlap > 0 ? "path-similarity" : "fuzzy-match";

      fixes.push({
        originalHref: brokenUrl,
        suggestedHref: bestMatch.url,
        confidence: bestMatch.score,
        method,
        sourcePages,
      });
    }
  }

  // Sort by confidence descending
  fixes.sort((a, b) => b.confidence - a.confidence);
  return fixes;
}

/**
 * Convert link fixes to redirect entries (for generating redirect configs).
 */
export function fixesToRedirects(
  fixes: LinkFix[],
  minConfidence: number = 0.6
): RedirectEntry[] {
  return fixes
    .filter((fix) => fix.confidence >= minConfidence)
    .map((fix) => ({
      from: getPathname(fix.originalHref),
      to: getPathname(fix.suggestedHref),
      statusCode: 301 as const,
    }));
}

/**
 * Apply link fixes to file content.
 * Returns the modified content with broken hrefs replaced.
 */
export function applyFixesToContent(
  content: string,
  fixes: LinkFix[],
  minConfidence: number = 0.7
): { content: string; appliedCount: number } {
  let modified = content;
  let appliedCount = 0;

  for (const fix of fixes) {
    if (fix.confidence < minConfidence) continue;

    // Replace href values in HTML attributes
    const originalPath = getPathname(fix.originalHref);
    const suggestedPath = getPathname(fix.suggestedHref);

    // Match href="<path>" or href='<path>'
    const patterns = [
      new RegExp(`href="${escapeRegex(originalPath)}"`, "g"),
      new RegExp(`href='${escapeRegex(originalPath)}'`, "g"),
      new RegExp(`href="${escapeRegex(fix.originalHref)}"`, "g"),
      new RegExp(`href='${escapeRegex(fix.originalHref)}'`, "g"),
    ];

    for (const pattern of patterns) {
      const before = modified;
      modified = modified.replace(pattern, (match) => {
        return match.replace(
          match.includes(fix.originalHref) ? fix.originalHref : originalPath,
          match.includes(fix.originalHref) ? fix.suggestedHref : suggestedPath
        );
      });
      if (modified !== before) {
        appliedCount++;
      }
    }
  }

  return { content: modified, appliedCount };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
