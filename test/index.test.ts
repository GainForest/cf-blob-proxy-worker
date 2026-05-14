import { describe, expect, it } from "vitest";
import { parseSourceUrl, validateHost } from "../src/index";

describe("parseSourceUrl", () => {
  it("accepts valid https URLs", () => {
    const result = parseSourceUrl("https://example.com/file.bin#fragment");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.hash).toBe("");
  });

  it("rejects missing or non-https URLs", () => {
    expect(parseSourceUrl("not a url").ok).toBe(false);
    expect(parseSourceUrl("http://example.com/file.bin").ok).toBe(false);
    expect(parseSourceUrl("file:///etc/passwd").ok).toBe(false);
  });
});

describe("validateHost", () => {
  it("blocks private and local hosts even without allowlist", () => {
    for (const url of [
      "https://localhost/file.bin",
      "https://127.0.0.1/file.bin",
      "https://10.0.0.1/file.bin",
      "https://172.16.0.1/file.bin",
      "https://192.168.1.2/file.bin",
      "https://service.local/file.bin",
    ]) {
      expect(validateHost(new URL(url), "").ok).toBe(false);
    }
  });

  it("honors exact and wildcard allowlist entries", () => {
    expect(validateHost(new URL("https://assets.example.com/file.bin"), "assets.example.com").ok).toBe(true);
    expect(validateHost(new URL("https://cdn.example.com/file.bin"), "*.example.com").ok).toBe(true);
    expect(validateHost(new URL("https://evil.com/file.bin"), "*.example.com").ok).toBe(false);
  });
});
