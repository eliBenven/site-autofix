import { describe, it, expect } from "vitest";
import {
  classifyError,
  extractStackTrace,
  recommendRemediation,
} from "../src/health-monitor.js";
import type { ErrorClass } from "../src/types.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("health-monitor", () => {
  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------
  describe("classifyError()", () => {
    it("should classify timeout (null status code)", () => {
      const result = classifyError(null, "request timed out", {}, 5000);
      expect(result).toBe("timeout");
    });

    it("should classify timeout (high response time)", () => {
      const result = classifyError(500, "slow", {}, 10000);
      expect(result).toBe("timeout");
    });

    it("should classify OOM errors", () => {
      expect(classifyError(500, "JavaScript heap out of memory", {}, 100)).toBe(
        "oom"
      );
      expect(classifyError(500, "OOM killed process", {}, 100)).toBe("oom");
      expect(
        classifyError(500, "Exceeded memory limit for function", {}, 100)
      ).toBe("oom");
    });

    it("should classify database errors", () => {
      expect(
        classifyError(500, "database connection refused", {}, 100)
      ).toBe("database-error");
      expect(
        classifyError(500, "SQL syntax error near ...", {}, 100)
      ).toBe("database-error");
      expect(
        classifyError(500, "ECONNREFUSED to postgres:5432", {}, 100)
      ).toBe("database-error");
      expect(
        classifyError(500, "MySQL connection pool exhausted", {}, 100)
      ).toBe("database-error");
      expect(
        classifyError(500, "MongoServerError: ...", {}, 100)
      ).toBe("database-error");
    });

    it("should classify upstream dependency errors by status code", () => {
      expect(classifyError(502, "Bad Gateway", {}, 100)).toBe(
        "upstream-dependency"
      );
      expect(classifyError(503, "Service Unavailable", {}, 100)).toBe(
        "upstream-dependency"
      );
      expect(classifyError(504, "Gateway Timeout", {}, 100)).toBe(
        "upstream-dependency"
      );
    });

    it("should classify upstream dependency errors by body content", () => {
      expect(
        classifyError(500, "upstream service returned error", {}, 100)
      ).toBe("upstream-dependency");
      expect(classifyError(500, "proxy error: ...", {}, 100)).toBe(
        "upstream-dependency"
      );
    });

    it("should classify configuration errors", () => {
      expect(
        classifyError(500, "Configuration key not found", {}, 100)
      ).toBe("configuration-error");
      expect(
        classifyError(500, "env variable API_URL is undefined", {}, 100)
      ).toBe("configuration-error");
      expect(
        classifyError(500, "Service not configured properly", {}, 100)
      ).toBe("configuration-error");
      expect(
        classifyError(500, "missing key: API_SECRET", {}, 100)
      ).toBe("configuration-error");
    });

    it("should classify unhandled exceptions", () => {
      expect(
        classifyError(500, "TypeError: Cannot read property 'x' of null", {}, 100)
      ).toBe("unhandled-exception");
      expect(
        classifyError(500, "ReferenceError: foo is not defined\n  at bar.js:10", {}, 100)
      ).toBe("unhandled-exception");
    });

    it("should return unknown when no pattern matches", () => {
      expect(classifyError(500, "", {}, 100)).toBe("unknown");
      expect(classifyError(500, null, {}, 100)).toBe("unknown");
    });
  });

  // -----------------------------------------------------------------------
  // Stack trace extraction
  // -----------------------------------------------------------------------
  describe("extractStackTrace()", () => {
    it("should return null for null input", () => {
      expect(extractStackTrace(null)).toBeNull();
    });

    it("should return null when no stack trace is present", () => {
      expect(extractStackTrace("Just a plain error message")).toBeNull();
    });

    it("should extract Node.js / JavaScript stack traces", () => {
      const body = `Something went wrong:
TypeError: Cannot read property 'x' of null
    at Object.<anonymous> (/app/server.js:10:15)
    at Module._compile (internal/modules/cjs/loader.js:999:30)
    at Module.load (internal/modules/cjs/loader.js:815:32)

End of output.`;

      const trace = extractStackTrace(body);
      expect(trace).not.toBeNull();
      expect(trace).toContain("TypeError");
      expect(trace).toContain("at Object.<anonymous>");
    });

    it("should extract Python stack traces", () => {
      const body = `Internal Server Error:
Traceback (most recent call last):
  File "/app/main.py", line 42, in handler
    result = process(data)
  File "/app/processor.py", line 17, in process
    return data["key"]
KeyError: 'key'

More text here.`;

      const trace = extractStackTrace(body);
      expect(trace).not.toBeNull();
      expect(trace).toContain("Traceback (most recent call last)");
      expect(trace).toContain("KeyError");
    });

    it("should extract Java / JVM stack traces", () => {
      const body = `Error processing request:
java.lang.NullPointerException: Something was null
    at com.example.App.handle(App.java:42)
    at com.example.Router.route(Router.java:100)
    at com.example.Server.serve(Server.java:55)

Done.`;

      const trace = extractStackTrace(body);
      expect(trace).not.toBeNull();
      expect(trace).toContain("NullPointerException");
      expect(trace).toContain("at com.example.App.handle");
    });

    it("should extract Ruby stack traces", () => {
      const body = `Application error:
/app/controllers/users_controller.rb:15:in 'create'
/app/lib/router.rb:42:in 'dispatch'
/app/lib/server.rb:10:in 'call'

End.`;

      const trace = extractStackTrace(body);
      expect(trace).not.toBeNull();
      expect(trace).toContain(".rb:");
    });
  });

  // -----------------------------------------------------------------------
  // Remediation recommendations
  // -----------------------------------------------------------------------
  describe("recommendRemediation()", () => {
    const allErrorClasses: ErrorClass[] = [
      "timeout",
      "oom",
      "database-error",
      "upstream-dependency",
      "configuration-error",
      "unhandled-exception",
      "unknown",
    ];

    it("should return a remediation for every error class", () => {
      for (const errorClass of allErrorClasses) {
        const remediation = recommendRemediation(errorClass);
        expect(remediation).toBeDefined();
        expect(remediation.triggeredBy).toBe(errorClass);
        expect(remediation.description.length).toBeGreaterThan(0);
        expect(["restart", "rollback", "feature-flag-off", "open-issue"]).toContain(
          remediation.type
        );
      }
    });

    it("should recommend restart for timeout", () => {
      const r = recommendRemediation("timeout");
      expect(r.type).toBe("restart");
      expect(r.autoApplicable).toBe(true);
    });

    it("should recommend restart for oom", () => {
      const r = recommendRemediation("oom");
      expect(r.type).toBe("restart");
      expect(r.autoApplicable).toBe(true);
    });

    it("should recommend restart for database-error", () => {
      const r = recommendRemediation("database-error");
      expect(r.type).toBe("restart");
      expect(r.autoApplicable).toBe(true);
    });

    it("should recommend open-issue for upstream-dependency", () => {
      const r = recommendRemediation("upstream-dependency");
      expect(r.type).toBe("open-issue");
      expect(r.autoApplicable).toBe(false);
    });

    it("should recommend rollback for configuration-error", () => {
      const r = recommendRemediation("configuration-error");
      expect(r.type).toBe("rollback");
      expect(r.autoApplicable).toBe(true);
    });

    it("should recommend feature-flag-off for unhandled-exception", () => {
      const r = recommendRemediation("unhandled-exception");
      expect(r.type).toBe("feature-flag-off");
      expect(r.autoApplicable).toBe(true);
    });

    it("should recommend open-issue for unknown", () => {
      const r = recommendRemediation("unknown");
      expect(r.type).toBe("open-issue");
      expect(r.autoApplicable).toBe(false);
    });
  });
});
