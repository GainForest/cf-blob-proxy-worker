# Cloudflare Worker Blob Proxy

A small TypeScript Cloudflare Worker that exposes:

```txt
GET /blob?url=<encoded-blob-url>
```

It fetches HTTPS remote blobs, validates hosts, enforces a size limit, caches successful responses at the Cloudflare edge, and returns public CORS-enabled blob responses.

## File structure

```txt
cf-blob-proxy-worker/
  src/index.ts
  test/index.test.ts
  wrangler.toml
  package.json
  tsconfig.json
  README.md
```

## Configuration

Set these Worker environment variables in `wrangler.toml` or the Cloudflare dashboard:

| Variable | Default | Description |
| --- | --- | --- |
| `ALLOWED_BLOB_HOSTS` | empty | Comma-separated trusted hostnames. Supports exact hosts and wildcards like `*.example.com`. If empty, public HTTPS blob URLs are allowed except dangerous/private/internal hosts. |
| `MAX_BLOB_BYTES` | `10485760` | Maximum upstream blob size in bytes. Defaults to 10 MB. |
| `FETCH_TIMEOUT_MS` | `8000` | Upstream fetch timeout in milliseconds. |

Example allowlist:

```toml
[vars]
ALLOWED_BLOB_HOSTS = "assets.example.com,*.trusted-cdn.com"
MAX_BLOB_BYTES = "10485760"
FETCH_TIMEOUT_MS = "8000"
```

## Local development

```bash
cd cf-blob-proxy-worker
npm install
npm run typecheck
npm test
npm run dev
```

Test locally:

```bash
curl "http://localhost:8787/blob?url=https%3A%2F%2Fexample.com%2Ffile.bin"
```

## Deploy

```bash
cd cf-blob-proxy-worker
npm install
npm run typecheck
npm test
npm run deploy
```

Then map your Worker to a custom domain such as:

```txt
https://blob.example.com
```

## Next.js usage

Set your app environment variable:

```env
NEXT_PUBLIC_BLOB_PROXY_URL=https://blob.example.com
```

Build proxied blob URLs like:

```ts
const proxiedUrl = `${process.env.NEXT_PUBLIC_BLOB_PROXY_URL}/blob?url=${encodeURIComponent(originalBlobUrl)}`;
```

Example output:

```txt
https://blob.example.com/blob?url=<encoded-original-url>
```

## Security behavior

- Requires source URLs to be valid `https:` URLs.
- Rejects non-HTTP(S) schemes; because HTTPS is required, `http:` is also rejected.
- Blocks obvious private/internal hosts including localhost, loopback, private IPv4 ranges, link-local ranges, multicast/reserved IPv4 ranges, IPv6 loopback/link-local/ULA, and `.local` names.
- Does not forward cookies or authorization headers to upstream.
- Preserves safe upstream headers: `Content-Type`, `Content-Disposition`, `ETag`, and `Last-Modified`.
- Returns clean JSON errors with appropriate status codes.
- Caches successful blob responses with:

```txt
Cache-Control: public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400
```
