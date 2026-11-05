# Running and hosting Meatproxy

For what the service does and how transfers work, see the [README](../README.md) and [how-it-works.md](how-it-works.md).

## Local development

```sh
npm ci
npm run build
npm start
```

Open http://localhost:3477. Once the first file or note is prepared, the page opens the sender connection and creates a room; its address becomes the recipient URL. Empty homepage tabs do not hold connections. `npm run build` bundles the shared crypto protocol and the Node receiver source into `public/receive.mjs`, builds the browser file worker, and regenerates the brand images. Regenerate it after changes to these sources. The file worker uses the pinned `@noble/hashes` SHA-256 implementation; its MIT license is shipped as `public/hashes-LICENSE.txt`. Build dependencies are not loaded from a CDN or needed by the production server. The server reads and fingerprints `public/` when it starts, so restart it after changing those files.

```sh
npm run check
npm test
```

For a real browser fallback test, keep the normal server running and run `node test/blocked-direct-proxy.mjs`. Open http://localhost:3478 in two browser tabs. The fixture suppresses initial WebRTC signaling so the production browser code must fall back to the encrypted relay after eight seconds. This test fixture is not deployed.

For a repeatable latency benchmark, run `node test/latency-proxy.mjs` with the normal server running. Open http://localhost:3479 and receive its complete link with the Node client. The fixture adds 50 ms per WebSocket hop, producing approximately 200 ms of added round-trip latency between the two peers. It is not deployed.

## Branding

The two folded pieces in `public/logo.svg` form the Meatproxy M. `npm run build:brand` generates the matching SVG/PNG favicons, Apple touch icon, and 1200 × 630 social images from this mark, `brand/social.svg`, and `brand/handoff.svg`. The renderer is a development dependency; the server only serves the finished assets. The bundled Atkinson Hyperlegible fonts are licensed under the [SIL Open Font License](../brand/fonts/OFL.txt), sourced from [Google Fonts](https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegible).

## Hosting

Run the app as its own unprivileged service behind an HTTPS reverse proxy. It listens on `127.0.0.1:3477` by default; set `PORT` to change the port and `PUBLIC_ORIGIN` to the public HTTPS origin. Forward WebSocket upgrades for `/socket`, disable proxy buffering and caching, and allow idle WebSocket connections for at least 90 seconds. Use `/healthz` for health checks.

Soon after each midnight UTC, the service writes one JSON line to standard output (`"event":"daily-usage"`) with the previous day's totals: relay allowance used (`relayedBytes`, including overhead and slices still reserved), signal bytes, rooms created, peak sockets, sockets slowed for their work budget (`throttled`), connections refused with 429 before the WebSocket handshake (`refused`), and connections closed by each limit, by close code (`closedByLimit`). A restart resets the day's counts, so the service writes the same totals as `"event":"usage-at-shutdown"` when it stops. The lines contain no addresses or room IDs. Under systemd, read them with `journalctl -u <service>`.

Limit the rate of HTTP requests and new connections per client address at the proxy or CDN; the application's work budget covers what happens on a connection, not the cost of answering requests. In Nginx, a `limit_req_zone` keyed on `$binary_remote_addr` with a `limit_req` in the proxied location, and a `limit_conn` on the same key, are enough; Cloudflare rate-limiting rules can do it ahead of the origin. An `upstream` block with `keepalive` would also spare the application a connection per request, but it needs `proxy_set_header Connection ""`, which one location cannot combine with forwarding WebSocket upgrades; give it a separate location, or set the header from a `map` over `$http_upgrade`.

The per-address limits read the client's address from `X-Real-IP`, so the proxy must always set that header itself, overwriting any value a client sent. Without the header, as when running locally without a proxy, no per-address limits apply; the per-link and whole-relay limits still do. Behind Cloudflare, set the address from `CF-Connecting-IP` only for requests from [Cloudflare's address ranges](https://www.cloudflare.com/ips/) (Nginx: `set_real_ip_from` for each range, `real_ip_header CF-Connecting-IP`, and `proxy_set_header X-Real-IP $remote_addr` in the proxied location).

Pages reference scripts, styles, and images as `/file?v=<version>`, where the version is the start of a SHA-256 over the response headers and the file after its own references are versioned. A module's version therefore changes when anything it imports changes. Only a request for the current version gets `Cache-Control: public, max-age=31536000, immutable`, which lets browsers keep it; Cloudflare's default rules also cache the `.js`, `.css`, `.png`, and `.svg` files, but not `.mjs` or `.txt`. Pages, status responses, and unversioned or outdated asset URLs stay `no-store, no-transform`; `no-transform` stops Cloudflare adding its Web Analytics script to pages, which the content security policy would block. Each release computes versions from its own files when the service starts, so a deploy gives every changed file a new URL without purging any cache. Versions cover only headers the application sets; after changing headers that Nginx or Cloudflare add to responses, purge Cloudflare's cache. Versioned URLs depend on Cloudflare including the query string in its cache key, as its default caching level does. `/receive.mjs` stays available without a version for the command-line download.

Cloudflare can proxy the domain and terminate public TLS. Use **Full (Strict)** with a valid certificate at the origin. Keep the application process and virtual host separate from other sites. A service restart ends active rooms, so preserve the previous release for rollback.

Machine-specific deployment notes, host inventories, test artifacts, credentials, and local backups are excluded from this repository.
