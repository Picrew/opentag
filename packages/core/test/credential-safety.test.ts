import { describe, expect, it } from "vitest";
import {
  containsCredentialLikeData,
  isCredentialSafeDisplayResource,
  isCredentialFieldName,
  isCredentialSafeValue,
  redactCredentialLikeData,
  sanitizeCredentialLikeValue
} from "../src/credential-safety.js";

describe("credential safety", () => {
  it.each([
    "ghp\x5fabcdefghijklmnopqrstuvwxyz123456",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "xoxb\x2d1234567890-abcdefghijklmnopqrstuvwxyz",
    "sk\x5flive_abcdefghijklmnopqrstuvwxyz",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
    "Bearer abcdefghijklmnopqrstuvwxyz",
    "AKIAIOSFODNN7EXAMPLE",
    "AIzaSyDabcdefghijklmnopqrstuvwxyz12345",
    "password=hunter2",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"
  ])("detects %s", (value) => {
    expect(containsCredentialLikeData(value)).toBe(true);
    expect(redactCredentialLikeData(value)).not.toContain(value);
  });

  it.each(["authorization", "apiKey", "x-amz-signature", "x-goog-credential", "private_key", "refreshToken"])("classifies %s as a credential field", (value) => {
    expect(isCredentialFieldName(value)).toBe(true);
  });

  it("accepts ordinary constraints and rejects credential-bearing nested records", () => {
    expect(isCredentialSafeValue({ environment: "staging", force: false, visibility: "private" })).toBe(true);
    expect(isCredentialSafeValue({ nested: { accessToken: "hidden" } })).toBe(false);
  });

  it("accepts only credential-free query-free display resources", () => {
    expect(isCredentialSafeDisplayResource("https://example.test/deploy")).toBe(true);
    expect(isCredentialSafeDisplayResource("https://example.test/deploy?environment=staging")).toBe(false);
    expect(isCredentialSafeDisplayResource("https://user:password@example.test/deploy")).toBe(false);
    expect(isCredentialSafeDisplayResource("ftp://example.test/deploy")).toBe(false);
    expect(isCredentialSafeDisplayResource("https://example test/deploy")).toBe(false);
    expect(isCredentialSafeDisplayResource("workspace/report.md")).toBe(true);
  });

  it("removes URL userinfo from redacted audit text", () => {
    const redacted = redactCredentialLikeData("request failed for https://operator:password@example.test/deploy");
    expect(redacted).toContain("https://example.test/deploy");
    expect(redacted).not.toMatch(/operator|password/iu);
  });

  it("redacts repeated private-key headers with a linear boundary scan", () => {
    const repeated = "-----BEGIN PRIVATE KEY-----".repeat(10_000);
    const redacted = redactCredentialLikeData(repeated);

    expect(containsCredentialLikeData(repeated)).toBe(true);
    expect(redacted).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(redacted).toBe("[redacted private key]");
  });

  it("fails closed when private-key material has no end boundary", () => {
    const truncated = "prefix\n-----BEGIN PRIVATE KEY-----\nSUPERSECRETBASE64\nnext log line";
    const redacted = redactCredentialLikeData(truncated);

    expect(redacted).toBe("prefix\n[redacted private key]");
    expect(redacted).not.toMatch(/SUPERSECRETBASE64|next log line/u);
  });

  it("recursively sanitizes credential fields, detected tokens, and active runtime secrets without changing shape", () => {
    const activeFencingToken = "opaque-fence-value-not-detectable-by-pattern";
    const input = {
      summary: `completed with ${activeFencingToken}`,
      metadata: {
        accessToken: "innocent-looking-secret",
        nested: ["Bearer abcdefghijklmnopqrstuvwxyz", { note: `again ${activeFencingToken}` }]
      }
    };

    expect(sanitizeCredentialLikeValue(input, { secrets: [activeFencingToken] })).toEqual({
      summary: "completed with [redacted]",
      metadata: {
        nested: ["Bearer [redacted]", { note: "again [redacted]" }]
      }
    });
    expect(input.metadata.accessToken).toBe("innocent-looking-secret");
  });
});
