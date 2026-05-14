export interface Env {
  ALLOWED_BLOB_HOSTS?: string;
  MAX_BLOB_BYTES?: string;
  FETCH_TIMEOUT_MS?: string;
  ALLOW_SVG?: string;
}

const ONE_YEAR_SECONDS = 31_536_000;
const CACHE_CONTROL = `public, max-age=${ONE_YEAR_SECONDS}, s-maxage=${ONE_YEAR_SECONDS}, immutable`;
const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_IMAGE_HEIGHT = 4096;
const ALLOWED_WIDTHS = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048] as const;
const IMAGE_FITS = ["cover", "contain", "scale-down", "crop", "pad"] as const;
const IMAGE_FORMATS = ["auto", "webp", "avif", "jpeg", "png"] as const;
const SAFE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

type ImageFit = typeof IMAGE_FITS[number];
type ImageFormat = typeof IMAGE_FORMATS[number];

interface ImageParams {
  width?: number;
  height?: number;
  quality: number;
  fit: ImageFit;
  format: ImageFormat;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method !== "GET") return jsonError("method_not_allowed", "Only GET is allowed.", 405);

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/blob") return handleBlob(requestUrl, env, ctx);
    if (requestUrl.pathname === "/image") return handleImage(requestUrl, env, ctx);
    return jsonError("not_found", "Use /blob?url=<encoded-blob-url> or /image?url=<encoded-source-url>.", 404);
  },
};

async function handleBlob(requestUrl: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rawUrl = requestUrl.searchParams.get("url");
  if (!rawUrl) return jsonError("bad_url", "Missing url query parameter.", 400);

  const parsed = parseSourceUrl(rawUrl, "Blob");
  if (!parsed.ok) return jsonError("bad_url", parsed.message, 400);

  const blocked = validateHost(parsed.url, env.ALLOWED_BLOB_HOSTS ?? "");
  if (!blocked.ok) return jsonError("blocked_host", blocked.message, 403);

  const normalizedUrl = normalizeSourceUrl(parsed.url);
  const cacheKey = new Request(`https://blob-proxy-cache.local/blob?url=${encodeURIComponent(normalizedUrl)}`, { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cors(cached);

  const timeoutMs = readPositiveInt(env.FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxBytes = readPositiveInt(env.MAX_BLOB_BYTES, DEFAULT_MAX_BLOB_BYTES);

  const upstream = await fetchWithTimeout(normalizedUrl, timeoutMs, "blob", { Accept: "*/*" });
  if (!upstream.ok) return upstream.response;

  const contentLength = upstream.response.headers.get("Content-Length");
  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    return jsonError("too_large", "Upstream blob exceeds max size.", 403);
  }

  const body = await upstream.response.arrayBuffer();
  if (body.byteLength > maxBytes) return jsonError("too_large", "Upstream blob exceeds max size.", 403);

  const headers = new Headers();
  copyHeader(upstream.response.headers, headers, "Content-Type");
  copyHeader(upstream.response.headers, headers, "Content-Disposition");
  copyHeader(upstream.response.headers, headers, "ETag");
  copyHeader(upstream.response.headers, headers, "Last-Modified");
  headers.set("Cache-Control", CACHE_CONTROL);
  headers.set("Content-Length", String(body.byteLength));
  addCorsHeaders(headers);

  const response = new Response(body, { status: 200, headers });
  ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

async function handleImage(requestUrl: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rawUrl = requestUrl.searchParams.get("url");
  if (!rawUrl) return jsonError("bad_url", "Missing url query parameter.", 400);

  const parsed = parseSourceUrl(rawUrl, "Image");
  if (!parsed.ok) return jsonError("bad_url", parsed.message, 400);

  const blocked = validateHost(parsed.url, env.ALLOWED_BLOB_HOSTS ?? "");
  if (!blocked.ok) return jsonError("blocked_host", blocked.message, 403);

  const imageParams = parseImageParams(requestUrl.searchParams);
  if (!imageParams.ok) return jsonError("invalid_query", imageParams.message, 400);

  const normalizedUrl = normalizeSourceUrl(parsed.url);
  const cacheKey = new Request(`https://blob-proxy-cache.local/image?url=${encodeURIComponent(normalizedUrl)}&w=${imageParams.params.width ?? ""}&h=${imageParams.params.height ?? ""}&q=${imageParams.params.quality}&fit=${imageParams.params.fit}&format=${imageParams.params.format}`, { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cors(cached);

  const timeoutMs = readPositiveInt(env.FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const upstream = await fetchWithTimeout(normalizedUrl, timeoutMs, "image", { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1" }, imageParams.params);
  if (!upstream.ok) return upstream.response;

  const contentType = getBaseContentType(upstream.response.headers.get("Content-Type"));
  if (!isAllowedImageContentType(contentType, env.ALLOW_SVG === "true")) {
    return jsonError("blocked_type", "Upstream response is not an allowed image type.", 403);
  }

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  copyHeader(upstream.response.headers, headers, "ETag");
  copyHeader(upstream.response.headers, headers, "Last-Modified");
  headers.set("Cache-Control", CACHE_CONTROL);
  addCorsHeaders(headers);

  const response = new Response(upstream.response.body, { status: 200, headers });
  ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

export function parseImageParams(params: URLSearchParams): { ok: true; params: ImageParams } | { ok: false; message: string } {
  const width = parseOptionalInt(params.get("w"), "w");
  if (!width.ok) return width;
  const height = parseOptionalInt(params.get("h"), "h");
  if (!height.ok) return height;
  if (height.value !== undefined && height.value > MAX_IMAGE_HEIGHT) return { ok: false, message: `h must be <= ${MAX_IMAGE_HEIGHT}.` };

  const quality = parseOptionalInt(params.get("q"), "q");
  if (!quality.ok) return quality;
  const q = quality.value ?? 75;
  if (q < 1 || q > 100) return { ok: false, message: "q must be between 1 and 100." };

  const fit = params.get("fit") ?? "scale-down";
  if (!isOneOf(fit, IMAGE_FITS)) return { ok: false, message: "fit must be one of cover, contain, scale-down, crop, pad." };

  const format = params.get("format") ?? "auto";
  if (!isOneOf(format, IMAGE_FORMATS)) return { ok: false, message: "format must be one of auto, webp, avif, jpeg, png." };

  const parsed: ImageParams = { quality: q, fit, format };
  if (width.value !== undefined) parsed.width = roundWidthUp(width.value);
  if (height.value !== undefined) parsed.height = height.value;
  return { ok: true, params: parsed };
}

function parseOptionalInt(value: string | null, name: string): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === null || value === "") return { ok: true };
  if (!/^\d+$/.test(value)) return { ok: false, message: `${name} must be a positive integer.` };
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return { ok: false, message: `${name} must be a positive integer.` };
  return { ok: true, value: parsed };
}

function roundWidthUp(width: number): number {
  return ALLOWED_WIDTHS.find((allowed) => allowed >= width) ?? 2048;
}

function isOneOf<T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return allowed.includes(value);
}

async function fetchWithTimeout(sourceUrl: string, timeoutMs: number, kind: "blob" | "image", headers: Record<string, string>, image?: ImageParams): Promise<{ ok: true; response: Response } | { ok: false; response: Response }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { ...headers, "User-Agent": "cloudflare-worker-blob-proxy/1.0" },
    };
    const cf = image ? { image: toCfImageOptions(image), cacheEverything: true, cacheTtl: ONE_YEAR_SECONDS } : undefined;
    const response = await fetch(sourceUrl, cf ? { ...init, cf } : init);
    if (response.status === 404) return { ok: false, response: jsonError("upstream_not_found", `Upstream ${kind} was not found.`, 404) };
    if (!response.ok) return { ok: false, response: jsonError("upstream_error", `Upstream returned ${response.status}.`, 502) };
    return { ok: true, response };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, response: jsonError("timeout", `Upstream ${kind} fetch timed out.`, 504) };
    }
    return { ok: false, response: jsonError("upstream_fetch_failed", `Failed to fetch upstream ${kind}.`, 502) };
  } finally {
    clearTimeout(timeout);
  }
}

function toCfImageOptions(params: ImageParams): RequestInitCfPropertiesImage {
  const options: RequestInitCfPropertiesImage = {
    quality: params.quality,
    fit: params.fit,
  };
  if (params.width !== undefined) options.width = params.width;
  if (params.height !== undefined) options.height = params.height;
  if (params.format !== "auto") options.format = params.format;
  return options;
}

export function parseSourceUrl(value: string, label = "Blob"): { ok: true; url: URL } | { ok: false; message: string } {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return { ok: false, message: `${label} URL must use https.` };
    if (!url.hostname) return { ok: false, message: `${label} URL must include a host.` };
    url.hash = "";
    return { ok: true, url };
  } catch {
    return { ok: false, message: `Malformed ${label.toLowerCase()} URL.` };
  }
}

export function validateHost(url: URL, allowlistValue: string): { ok: true } | { ok: false; message: string } {
  const hostname = normalizeHostname(url.hostname);
  if (isDangerousHost(hostname)) return { ok: false, message: "Host is private or internal." };

  const allowlist = allowlistValue.split(",").map((host) => normalizeHostname(host.trim())).filter(Boolean);
  if (allowlist.length > 0 && !allowlist.some((entry) => matchesAllowedHost(hostname, entry))) {
    return { ok: false, message: "Host is not in the blob allowlist." };
  }
  return { ok: true };
}

export function isAllowedImageContentType(contentType: string, allowSvg: boolean): boolean {
  return SAFE_IMAGE_TYPES.has(contentType) || (allowSvg && contentType === "image/svg+xml");
}

function normalizeSourceUrl(url: URL): string {
  url.protocol = url.protocol.toLowerCase();
  url.hostname = normalizeHostname(url.hostname);
  return url.toString();
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

function matchesAllowedHost(hostname: string, entry: string): boolean {
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1);
    return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
  }
  return hostname === entry;
}

function isDangerousHost(hostname: string): boolean {
  if (["localhost", "0", "0.0.0.0", "127.0.0.1", "::1"].includes(hostname)) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".localhost")) return true;
  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) return true;
  return false;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || a === 0 || a >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") || host === "::";
}

function getBaseContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function copyHeader(from: Headers, to: Headers, name: string): void {
  const value = from.get(name);
  if (value) to.set(name, value);
}

function jsonError(code: string, message: string, status: number): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  addCorsHeaders(headers);
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  addCorsHeaders(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function addCorsHeaders(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
}
