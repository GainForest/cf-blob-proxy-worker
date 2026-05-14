import { describe, expect, it } from "vitest";
import { isAllowedImageContentType, parseImageParams, parseSourceUrl, validateHost } from "../src/index";

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

describe("parseImageParams", () => {
  it("defaults and rounds width up to allowed sizes", () => {
    const result = parseImageParams(new URLSearchParams("w=641"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.width).toBe(750);
      expect(result.params.quality).toBe(75);
      expect(result.params.fit).toBe("scale-down");
      expect(result.params.format).toBe("auto");
    }
  });

  it("rejects invalid image params", () => {
    expect(parseImageParams(new URLSearchParams("q=0")).ok).toBe(false);
    expect(parseImageParams(new URLSearchParams("q=101")).ok).toBe(false);
    expect(parseImageParams(new URLSearchParams("fit=stretch")).ok).toBe(false);
    expect(parseImageParams(new URLSearchParams("format=gif")).ok).toBe(false);
    expect(parseImageParams(new URLSearchParams("h=99999")).ok).toBe(false);
  });
});

describe("isAllowedImageContentType", () => {
  it("allows safe raster image types and gates svg", () => {
    expect(isAllowedImageContentType("image/jpeg", false)).toBe(true);
    expect(isAllowedImageContentType("image/avif", false)).toBe(true);
    expect(isAllowedImageContentType("image/svg+xml", false)).toBe(false);
    expect(isAllowedImageContentType("image/svg+xml", true)).toBe(true);
  });
});
