import { describe, it, expect } from "vitest";
import {
  computeFixes,
  fixesToRedirects,
  applyFixesToContent,
} from "../src/link-fixer.js";
import type { LinkCheckResult, LinkFix } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helper to build a LinkCheckResult
// ---------------------------------------------------------------------------

function brokenLink(overrides: Partial<LinkCheckResult> = {}): LinkCheckResult {
  return {
    sourcePage: "https://example.com/page",
    href: "https://example.com/old-page",
    resolvedUrl: "https://example.com/old-page",
    statusCode: 404,
    isRedirect: false,
    finalUrl: null,
    redirectChain: [],
    error: null,
    ...overrides,
  };
}

function redirectLink(
  overrides: Partial<LinkCheckResult> = {}
): LinkCheckResult {
  return {
    sourcePage: "https://example.com/page",
    href: "https://example.com/moved",
    resolvedUrl: "https://example.com/moved",
    statusCode: 301,
    isRedirect: true,
    finalUrl: "https://example.com/new-location",
    redirectChain: ["https://example.com/moved"],
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("link-fixer", () => {
  // -----------------------------------------------------------------------
  // Fuzzy matching via Levenshtein distance (exercised through computeFixes)
  // -----------------------------------------------------------------------
  describe("fuzzy matching (Levenshtein distance)", () => {
    it("should match a URL with a small typo to the correct known-good URL", () => {
      const broken = [
        brokenLink({ href: "https://example.com/docss/guide" }),
      ];
      const knownGood = [
        "https://example.com/docs/guide",
        "https://example.com/about",
        "https://example.com/contact",
      ];

      const fixes = computeFixes(broken, knownGood, [], { minConfidence: 0.3 });

      expect(fixes.length).toBeGreaterThanOrEqual(1);
      expect(fixes[0]!.suggestedHref).toBe("https://example.com/docs/guide");
    });

    it("should not match when all known-good URLs are very different", () => {
      const broken = [
        brokenLink({ href: "https://example.com/xyz/abc/123" }),
      ];
      const knownGood = [
        "https://example.com/completely/different",
        "https://example.com/nothing/similar",
      ];

      const fixes = computeFixes(broken, knownGood, [], {
        minConfidence: 0.8,
      });
      expect(fixes.length).toBe(0);
    });

    it("should rank higher-similarity matches above lower ones", () => {
      const broken = [
        brokenLink({ href: "https://example.com/blog/post-one" }),
      ];
      const knownGood = [
        "https://example.com/blog/post-once", // very close (1 extra char)
        "https://example.com/about",
      ];

      const fixes = computeFixes(broken, knownGood, [], {
        minConfidence: 0.3,
      });
      expect(fixes.length).toBe(1);
      expect(fixes[0]!.suggestedHref).toBe(
        "https://example.com/blog/post-once"
      );
    });
  });

  // -----------------------------------------------------------------------
  // Redirect target matching
  // -----------------------------------------------------------------------
  describe("redirect target matching", () => {
    it("should use the redirect final URL as the suggested fix", () => {
      const broken = [
        brokenLink({ href: "https://example.com/moved-page" }),
      ];
      const redirects = [
        redirectLink({
          href: "https://example.com/moved-page",
          finalUrl: "https://example.com/new-page",
        }),
      ];

      const fixes = computeFixes(broken, [], redirects);

      expect(fixes.length).toBe(1);
      expect(fixes[0]!.suggestedHref).toBe("https://example.com/new-page");
      expect(fixes[0]!.method).toBe("redirect-target");
      expect(fixes[0]!.confidence).toBe(0.95);
    });

    it("should prefer redirect target over fuzzy match", () => {
      const broken = [
        brokenLink({ href: "https://example.com/old" }),
      ];
      const knownGood = ["https://example.com/oldd"]; // close fuzzy match
      const redirects = [
        redirectLink({
          href: "https://example.com/old",
          finalUrl: "https://example.com/brand-new",
        }),
      ];

      const fixes = computeFixes(broken, knownGood, redirects);

      // Redirect target should be chosen (confidence 0.95 vs fuzzy)
      expect(fixes.length).toBe(1);
      expect(fixes[0]!.suggestedHref).toBe("https://example.com/brand-new");
      expect(fixes[0]!.method).toBe("redirect-target");
    });
  });

  // -----------------------------------------------------------------------
  // Fix computation with known broken -> existing page pairs
  // -----------------------------------------------------------------------
  describe("fix computation", () => {
    it("should compute fixes for multiple broken links", () => {
      const broken = [
        brokenLink({
          href: "https://example.com/docs/getting-started",
          sourcePage: "https://example.com/",
        }),
        brokenLink({
          href: "https://example.com/blog/my-post",
          sourcePage: "https://example.com/blog",
        }),
      ];
      const knownGood = [
        "https://example.com/docs/getting-startd", // close typo
        "https://example.com/blog/my-postt", // close typo
      ];

      const fixes = computeFixes(broken, knownGood, [], {
        minConfidence: 0.3,
      });

      expect(fixes.length).toBe(2);
    });

    it("should deduplicate broken links by href and aggregate source pages", () => {
      const broken = [
        brokenLink({
          href: "https://example.com/missing",
          sourcePage: "https://example.com/page-a",
        }),
        brokenLink({
          href: "https://example.com/missing",
          sourcePage: "https://example.com/page-b",
        }),
      ];
      const knownGood = ["https://example.com/missingg"];

      const fixes = computeFixes(broken, knownGood, [], {
        minConfidence: 0.3,
      });

      // Should produce only one fix entry for the deduplicated href
      expect(fixes.length).toBe(1);
      expect(fixes[0]!.sourcePages).toContain(
        "https://example.com/page-a"
      );
      expect(fixes[0]!.sourcePages).toContain(
        "https://example.com/page-b"
      );
    });

    it("should sort fixes by confidence descending", () => {
      const broken = [
        brokenLink({ href: "https://example.com/aaa" }),
        brokenLink({ href: "https://example.com/bbb" }),
      ];
      const redirects = [
        redirectLink({
          href: "https://example.com/bbb",
          finalUrl: "https://example.com/bbb-new",
        }),
      ];
      const knownGood = ["https://example.com/aaaa"];

      const fixes = computeFixes(broken, knownGood, redirects, {
        minConfidence: 0.3,
      });

      // Redirect-target fix should be first (0.95 confidence)
      expect(fixes.length).toBe(2);
      expect(fixes[0]!.confidence).toBeGreaterThanOrEqual(
        fixes[1]!.confidence
      );
      expect(fixes[0]!.method).toBe("redirect-target");
    });

    it("should return empty array when no good matches exist", () => {
      const broken = [
        brokenLink({ href: "https://example.com/something" }),
      ];
      const fixes = computeFixes(broken, [], []);
      expect(fixes).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // fixesToRedirects() conversion
  // -----------------------------------------------------------------------
  describe("fixesToRedirects()", () => {
    it("should convert fixes to redirect entries with 301 status", () => {
      const fixes: LinkFix[] = [
        {
          originalHref: "https://example.com/old-path",
          suggestedHref: "https://example.com/new-path",
          confidence: 0.9,
          method: "redirect-target",
          sourcePages: ["https://example.com/"],
        },
      ];

      const redirects = fixesToRedirects(fixes);

      expect(redirects.length).toBe(1);
      expect(redirects[0]!.from).toBe("/old-path");
      expect(redirects[0]!.to).toBe("/new-path");
      expect(redirects[0]!.statusCode).toBe(301);
    });

    it("should filter out fixes below the min confidence threshold", () => {
      const fixes: LinkFix[] = [
        {
          originalHref: "https://example.com/a",
          suggestedHref: "https://example.com/b",
          confidence: 0.5,
          method: "fuzzy-match",
          sourcePages: [],
        },
        {
          originalHref: "https://example.com/c",
          suggestedHref: "https://example.com/d",
          confidence: 0.8,
          method: "path-similarity",
          sourcePages: [],
        },
      ];

      const redirects = fixesToRedirects(fixes, 0.7);

      expect(redirects.length).toBe(1);
      expect(redirects[0]!.from).toBe("/c");
    });

    it("should return empty array for empty fixes", () => {
      expect(fixesToRedirects([])).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // applyFixesToContent() href replacement in HTML
  // -----------------------------------------------------------------------
  describe("applyFixesToContent()", () => {
    it("should replace broken hrefs in HTML content", () => {
      const html = `
        <a href="/old-page">Link</a>
        <a href="/other-page">Other</a>
      `;
      const fixes: LinkFix[] = [
        {
          originalHref: "https://example.com/old-page",
          suggestedHref: "https://example.com/new-page",
          confidence: 0.9,
          method: "redirect-target",
          sourcePages: [],
        },
      ];

      const result = applyFixesToContent(html, fixes);

      expect(result.content).toContain('href="/new-page"');
      expect(result.content).toContain('href="/other-page"');
      expect(result.appliedCount).toBeGreaterThanOrEqual(1);
    });

    it("should handle single-quoted hrefs", () => {
      const html = `<a href='/old-path'>Link</a>`;
      const fixes: LinkFix[] = [
        {
          originalHref: "https://example.com/old-path",
          suggestedHref: "https://example.com/new-path",
          confidence: 0.9,
          method: "fuzzy-match",
          sourcePages: [],
        },
      ];

      const result = applyFixesToContent(html, fixes);

      expect(result.content).toContain("href='/new-path'");
    });

    it("should skip fixes below the min confidence", () => {
      const html = `<a href="/old-page">Link</a>`;
      const fixes: LinkFix[] = [
        {
          originalHref: "https://example.com/old-page",
          suggestedHref: "https://example.com/new-page",
          confidence: 0.5,
          method: "fuzzy-match",
          sourcePages: [],
        },
      ];

      const result = applyFixesToContent(html, fixes, 0.7);

      expect(result.content).toContain('href="/old-page"');
      expect(result.appliedCount).toBe(0);
    });

    it("should replace full URLs when they appear in href", () => {
      const html = `<a href="https://example.com/old-page">Link</a>`;
      const fixes: LinkFix[] = [
        {
          originalHref: "https://example.com/old-page",
          suggestedHref: "https://example.com/new-page",
          confidence: 0.9,
          method: "redirect-target",
          sourcePages: [],
        },
      ];

      const result = applyFixesToContent(html, fixes);

      expect(result.content).toContain("https://example.com/new-page");
      expect(result.appliedCount).toBeGreaterThanOrEqual(1);
    });

    it("should return unchanged content when no fixes apply", () => {
      const html = `<a href="/some-page">Link</a>`;
      const result = applyFixesToContent(html, []);

      expect(result.content).toBe(html);
      expect(result.appliedCount).toBe(0);
    });
  });
});
