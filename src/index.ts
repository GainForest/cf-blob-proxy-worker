export interface Env {
  ALLOWED_BLOB_HOSTS?: string;
  MAX_BLOB_BYTES?: string;
  FETCH_TIMEOUT_MS?: string;
}

const CACHE_CONTROL = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400";
const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method !== "GET") return jsonError("method_not_allowed", "Only GET is allowed.", 405);

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== "/blob") return jsonError("not_found", "Use /blob?url=<encoded-blob-url>.", 404);

    const rawUrl = requestUrl.searchParams.get("url");
    if (!rawUrl) return jsonError("bad_url", "Missing url query parameter.", 400);

    const parsed = parseSourceUrl(rawUrl);
    if (!parsed.ok) return jsonError("bad_url", parsed.message, 400);

    const blocked = validateHost(parsed.url, env.ALLOWED_BLOB_HOSTS ?? "");
    if (!blocked.ok) return jsonError("blocked_host", blocked.message, 403);

    const normalizedUrl = normalizeSourceUrl(parsed.url);
    const cacheKey = new Request(`https://blob-proxy-cache.local/blob?url=${encodeURIComponent(normalizedUrl)}`, { method: "GET" });
    const cached = await caches.default.match(cacheKey);
    if (cached) return cors(cached);

    const timeoutMs = readPositiveInt(env.FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const maxBytes = readPositiveInt(env.MAX_BLOB_BYTES, DEFAULT_MAX_BLOB_BYTES);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let upstream: Response;
    try {
      upstream = await fetch(normalizedUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "Accept": "*/*",
          "User-Agent": "cloudflare-worker-blob-proxy/1.0",
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return jsonError("timeout", "Upstream blob fetch timed out.", 504);
      }
      return jsonError("upstream_fetch_failed", "Failed to fetch upstream blob.", 502);
    } finally {
      clearTimeout(timeout);
    }

    if (upstream.status === 404) return jsonError("upstream_not_found", "Upstream blob was not found.", 404);
    if (!upstream.ok) return jsonError("upstream_error", `Upstream returned ${upstream.status}.`, 502);

    const contentLength = upstream.headers.get("Content-Length");
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      return jsonError("too_large", "Upstream blob exceeds max size.", 403);
    }

    const body = await upstream.arrayBuffer();
    if (body.byteLength > maxBytes) return jsonError("too_large", "Upstream blob exceeds max size.", 403);

    const headers = new Headers();
    copyHeader(upstream.headers, headers, "Content-Type");
    copyHeader(upstream.headers, headers, "Content-Disposition");
    copyHeader(upstream.headers, headers, "ETag");
    copyHeader(upstream.headers, headers, "Last-Modified");
    headers.set("Cache-Control", CACHE_CONTROL);
    headers.set("Content-Length", String(body.byteLength));
    addCorsHeaders(headers);

    const response = new Response(body, { status: 200, headers });
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  },
};

export function parseSourceUrl(value: string): { ok: true; url: URL } | { ok: false; message: string } {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return { ok: false, message: "Blob URL must use https." };
    if (!url.hostname) return { ok: false, message: "Blob URL must include a host." };
    url.hash = "";
    return { ok: true, url };
  } catch {
    return { ok: false, message: "Malformed blob URL." };
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
