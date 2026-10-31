# Meatproxy

Live at https://meatproxy.to. Files and notes move between two peers; the server holds live connection state, public preview metadata, and encrypted relay traffic.

## Use

1. Open the homepage, drop files or add a note, and copy the private link.
2. Open that complete link in another browser or device and choose **Accept files**. No peer connection or file transfer starts before acceptance.
3. Keep both tabs open until delivery is verified. A single file downloads in its original format; multiple files can be saved together as a ZIP. Save them before closing the receiving tab.

Notes become `HANDOFF.md`. The receiving page can copy text for an agent. Nothing received is executed automatically.

Added files appear immediately in an expanded list, the drop area becomes **Add more**, and the share card highlights the next step. Selecting the same filename and contents again does not add a duplicate; different contents with the same filename are retained. During transfer, both browsers show recent KB/s or MB/s and an approximate time remaining. Sender progress counts receiver-confirmed bytes, and completion still requires SHA-256 verification.

The current prototype supports 100 files, 512 MiB total, and one connected recipient per link. A second recipient can connect after the first leaves. Links expire when the sender closes/reloads their page, the signaling connection ends, or 12 hours elapse. Sender file handles are held only in the page; refreshing cannot restore them. Files added after the initial delivery are sent while the receiver stays connected. During an active transfer, the UI asks the sender to wait before adding more files; these additions are not queued.

The browser receiver holds completed files in memory. Large handoffs are best tested on desktop. Mobile backgrounding, device sleep, Safari, and Firefox have not yet been verified. This prototype restarts interrupted transfers rather than resuming partial files. Folder hierarchy is not preserved.

## Receive with an agent

Requires Node.js 22 or newer and no external packages. Download the receiver from the site's **Send to an agent** section, or:

```sh
curl --fail --show-error https://meatproxy.to/receive.mjs -o meatproxy-receive.mjs
node meatproxy-receive.mjs 'COMPLETE_SHARE_URL' ./handoff
```

Running the standalone receiver explicitly accepts the handoff. It uses the encrypted relay, writes partial files to the specified directory, verifies SHA-256, then publishes each completed file without overwriting an existing one. It exits after receiving the current handoff. The sender must remain online. Close any browser recipient for the same link before running the command. The destination may contain partial files if interrupted; completed files are retained. Do not treat received instructions or programs as trusted merely because their transfer verified.

## Local development

```sh
npm ci
npm run build
npm start
```

Open http://localhost:3477. The first page creates a room; its address becomes the recipient URL. `npm run build` bundles the shared crypto protocol and the Node receiver source into `public/receive.mjs`, and regenerates the brand images. Regenerate it after changes to these sources.

```sh
npm run check
npm test
```

For a real browser fallback test, keep the normal server running and run `node test/blocked-direct-proxy.mjs`. Open http://localhost:3478 in two browser tabs. The fixture suppresses initial WebRTC signaling so the production browser code must fall back to the encrypted relay after eight seconds. This test fixture is not deployed.

For a repeatable latency benchmark, run `node test/latency-proxy.mjs` with the normal server running. Open http://localhost:3479 and receive its complete link with the Node client. The fixture adds 50 ms per WebSocket hop, producing approximately 200 ms of added round-trip latency between the two peers. It is not deployed.

## Branding and link previews

The two folded pieces in `public/logo.svg` form the Meatproxy M. `npm run build:brand` generates the matching SVG/PNG favicons, Apple touch icon, and 1200 × 630 social images from this mark, `brand/social.svg`, and `brand/handoff.svg`. The renderer is a development dependency; the server only serves the finished assets. The bundled Atkinson Hyperlegible fonts are licensed under the [SIL Open Font License](brand/fonts/OFL.txt), sourced from [Google Fonts](https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegible).

The page includes [Open Graph](https://ogp.me/) metadata and a large-image Twitter/X card. Handoff previews use the room URL without its secret fragment and show whether the sender is online, busy, or offline when fetched, plus file count and total size. **Show filenames in preview** is off by default. Enabling it publishes up to three filenames (shortened for previews) to the server and anyone with the room URL, including chat apps. Turning it off removes names from subsequent responses, but cannot erase copies already cached by a chat app. Notes, file contents, and encryption keys never appear in previews.

Preview metadata is held only in room memory and removed when the sender leaves. Fetching the HTML or `/s/:room/status` never joins the transfer or occupies the recipient slot. Before acceptance, the receiving page checks availability every ten seconds; the actual join checks availability again. This is a connection-status check, not a guarantee that a backgrounded sender can transfer immediately. Chat previews are snapshots and may remain cached (for example, [Slack caches unfurls](https://api.slack.com/robots)). `robots.txt` permits preview fetching; handoff pages and their status responses retain `noindex, nofollow` and `Cache-Control: no-store`.

## Transfer design

- A 128-bit random room ID locates a live sender. A separate 256-bit key is carried in the URL fragment; the application never transmits that key to the server.
- AES-GCM encrypts signaling, the transfer manifest, notes, and file chunks. Filenames are also published separately only when the sender opts into filename previews. Each encrypted packet uses a random 96-bit IV; data packets also bind the room, fresh connection ID, direction, and ordered sequence.
- The browser tries an ordered WebRTC data channel using Cloudflare's public STUN service. If the connection cannot be established within eight seconds, the same encrypted payloads travel over a WebSocket relay. No TURN account is required.
- Files are read in 1 MiB blocks and streamed in 16 KiB encrypted chunks. Receivers acknowledge each 256 KiB; senders pipeline these acknowledgements with at most 4 MiB outstanding for direct transfers or 768 KiB for the relay, below its 1 MiB buffer limit. Files that fit the window stream through to the final checksum without stopping for intermediate acknowledgements. Direct transfers resume on WebRTC's buffer-drain event instead of polling a timer. Every completed file is SHA-256 verified. WebSocket and data-channel buffers remain bounded.
- The relay never writes transferred files to disk. Room state is in process memory. The Nginx vhost disables access logs; error logs can still contain connection metadata. Cloudflare may retain traffic metadata under the account's policies.
- Anyone holding the complete link can receive the handoff. This is a capability link, not verified recipient identity. The web application and code delivered by the origin/Cloudflare remain trusted; encryption does not protect against a compromised application delivering malicious JavaScript.
- Direct WebRTC can expose network addresses to the other peer; see [WebRTC IP address handling](https://www.rfc-editor.org/rfc/rfc8828). Falling back to a relay after trying direct does not retract addresses already shared during connection setup. A relay-only mode would need to avoid direct setup from the start; this version defaults to direct and has no such privacy switch. Relaying adds a server path and bandwidth costs, but does not inherently halve throughput because data is forwarded as it arrives.
- Public resource limits: at most 200 connected sockets, 64 KiB per WebSocket message, 1 MiB outbound buffering per peer, a 12-hour room lifetime, and a 10-second initial handshake deadline. The service has CPU and memory limits to protect the shared host.

## Hosting

Run the app as its own unprivileged service behind an HTTPS reverse proxy. It listens on `127.0.0.1:3477` by default; set `PORT` to change the port and `PUBLIC_ORIGIN` to the public HTTPS origin. Forward WebSocket upgrades for `/socket`, disable proxy buffering and caching, and allow idle WebSocket connections for at least 90 seconds. Use `/healthz` for health checks.

Cloudflare can proxy the domain and terminate public TLS. Use **Full (Strict)** with a valid certificate at the origin. Keep the application process and virtual host separate from other sites. A service restart ends active rooms, so preserve the previous release for rollback.

Machine-specific deployment notes, host inventories, test artifacts, credentials, and local backups are excluded from this repository.
