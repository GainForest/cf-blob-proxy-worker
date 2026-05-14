# Cloudflare Worker Blob Proxy

A TypeScript Cloudflare Worker with two public endpoints:

```txt
GET /blob?url=<encoded-blob-url>
GET /image?url=<encoded-source-url>&w=<width>&q=<quality>&fit=<fit>&format=<format>
```

`/blob` is a generic cached blob/file proxy. `/image` is image-only and uses Cloudflare Image Resizing via `cf.image`.

## Configuration

Set these Worker environment variables in `wrangler.toml` or the Cloudflare dashboard:

| Variable | Default | Description |
| --- | --- | --- |
| `ALLOWED_BLOB_HOSTS` | empty | Comma-separated trusted hostnames. Supports exact hosts and wildcards like `*.example.com`. If empty, public HTTPS URLs are allowed except dangerous/private/internal hosts. Used by both `/blob` and `/image`. A single space is treated as empty. |
| `MAX_BLOB_BYTES` | `10485760` | Maximum upstream blob size in bytes for `/blob`. Defaults to 10 MB. |
| `FETCH_TIMEOUT_MS` | `8000` | Upstream fetch timeout in milliseconds. |
| `ALLOW_SVG` | `false` | Set to `true` to allow SVG responses from `/image`. Keep disabled unless you trust sources. |

## `/blob` usage

Use this for generic blobs/files that should not be image-transformed:

```bash
curl "https://blob-proxy-worker.satyam1308mishra.workers.dev/blob?url=https%3A%2F%2Fexample.com%2Ffile.bin"
```

In JavaScript:

```ts
const proxiedBlobUrl = new URL("https://blob-proxy-worker.satyam1308mishra.workers.dev/blob");
proxiedBlobUrl.searchParams.set("url", originalBlobUrl);
```

## `/image` usage

Use this for images that should be resized/optimized by Cloudflare:

```bash
curl "https://blob-proxy-worker.satyam1308mishra.workers.dev/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&w=640&q=75&format=auto"
```

Supported image query params:

- `url`: required, encoded HTTPS source URL.
- `w`: optional width. Rounded up to the nearest allowed width: `16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048`.
- `h`: optional height. Must be a positive integer up to `4096`.
- `q`: optional quality from `1` to `100`. Defaults to `75`.
- `fit`: optional, one of `cover`, `contain`, `scale-down`, `crop`, `pad`. Defaults to `scale-down`, the safest default because it avoids upscaling.
- `format`: optional, one of `auto`, `webp`, `avif`, `jpeg`, `png`. Defaults to `auto`; internally this lets Cloudflare negotiate the best format.

Allowed image response types are `image/jpeg`, `image/png`, `image/webp`, `image/gif`, and `image/avif`. SVG is rejected unless `ALLOW_SVG=true`.

## Next.js custom image loader

Configure your app to generate Cloudflare-resized URLs directly:

```ts
function cloudflareImageLoader({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number;
}) {
  const url = new URL("https://blob-proxy-worker.satyam1308mishra.workers.dev/image");
  url.searchParams.set("url", src);
  url.searchParams.set("w", String(width));
  url.searchParams.set("q", String(quality ?? 75));
  url.searchParams.set("format", "auto");
  return url.href;
}
```

Then use either a custom loader or `unoptimized` so Next.js does not fetch and optimize the image server-side. The goal is for the browser to request the Worker URL directly and for Cloudflare to do the image resizing.

Example component usage:

```tsx
import Image from "next/image";

<Image
  src="https://example.com/photo.jpg"
  alt="Example"
  width={640}
  height={480}
  loader={cloudflareImageLoader}
  unoptimized
/>
```

## Local development

```bash
cd cf-blob-proxy-worker
npm install
npm run typecheck
npm test
npm run dev
```

## Deploy

```bash
cd cf-blob-proxy-worker
npm run typecheck
npm test
npm run deploy
```

## Security behavior

- Source URLs must be valid `https:` URLs.
- Blocks obvious private/internal hosts including localhost, loopback, private IPv4 ranges, link-local ranges, multicast/reserved IPv4 ranges, IPv6 loopback/link-local/ULA, and `.local` names.
- Uses the same hostname allowlist for both endpoints.
- Does not forward cookies or authorization headers to upstream.
- Adds CORS headers.
- Returns clean JSON errors with appropriate status codes.
- Caches successful responses with:

```txt
Cache-Control: public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400
```
