# Meatproxy

Live at https://meatproxy.to. Files and notes move between two peers; the server holds live connection state, public preview metadata, and encrypted relay traffic.

## Use

1. Open the homepage, drop files or add a note, and copy the private link.
2. Open that complete link in another browser or device and choose **Accept files**. No peer connection or file transfer starts before acceptance.
3. Keep both tabs open until delivery is verified. A single file downloads in its original format; multiple files can be saved together as a ZIP. Save them before closing the receiving tab.

Notes become `HANDOFF.md`. The receiving page can copy text for an agent. Nothing received is executed automatically.

Added files appear in an expanded list after preparation, the drop area becomes **Add more**, and the share card highlights the next step. Selecting the same filename and contents again does not add a duplicate; different contents with the same filename are retained. During transfer, both browsers show recent KB/s or MB/s and an approximate time remaining. Sender progress counts receiver-confirmed bytes, and completion still requires SHA-256 verification.

On phones, a fixed action bar keeps sharing, transfer progress, and saving within reach as the file list grows. It opens native link sharing when available and otherwise copies the link. The bar includes the keep-open reminder and leaves room for the page content and device safe area. Filename-preview controls are under **Link preview options**.

The file list shows the count and total size against the 100-file / 512 MiB limits. Remove files or edit notes created in the page before they are announced to a recipient. Saving an edit replaces that note; canceling retains its original contents. An open note edit is held back until saved or canceled. Files already announced to the connected receiver are locked for that connection. Added files and notes are queued while a transfer is running, then included in the next manifest before the handoff is marked complete. Invalid selections leave the existing handoff unchanged.

The current prototype supports one connected recipient per link. A second recipient can connect after the first leaves. Links expire when the sender closes/reloads their page, the signaling connection ends, or 12 hours elapse. Sender file handles are held only in the page; refreshing cannot restore them. Files added after the initial delivery are sent while the browser receiver stays connected.

For large handoffs, supporting browsers offer **Receive to a folder** before acceptance. Choose a destination and Meatproxy creates a new subfolder for this connection, streams incoming files to disk, and commits each file only after SHA-256 verification. Duplicate filenames get numbered names; existing files outside the new folder are untouched. A failed file is aborted and its unfinished entry is removed. Completed files remain saved if a later file fails. Reconnecting creates another subfolder.

The regular **Accept files** flow works without folder access. It retains browser-managed Blobs for downloading, so very large handoffs can still use substantial browser storage or memory. Both flows hash incrementally in a worker, using bounded reads and receive buffers instead of full-file JavaScript arrays. Multiple-file ZIP checksums also run in a separate worker, with preparation progress, so saving does not block the interface or incoming acknowledgements. File-system access is feature-detected; browsers without the folder picker use the regular download flow.

Mobile backgrounding, device sleep, Safari, and Firefox have not yet been verified. This prototype restarts interrupted transfers rather than resuming partial files. If the sender's page stops sending in the middle of a file for a minute, the receiving page says so and offers to reconnect; reconnecting resends the files that were not yet delivered. Folder hierarchy is not preserved.

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

Open http://localhost:3477. The first page creates a room; its address becomes the recipient URL. `npm run build` bundles the shared crypto protocol and the Node receiver source into `public/receive.mjs`, builds the browser file worker, and regenerates the brand images. Regenerate it after changes to these sources. The file worker uses the pinned `@noble/hashes` SHA-256 implementation; its MIT license is shipped as `public/hashes-LICENSE.txt`. Build dependencies are not loaded from a CDN or needed by the production server. The server reads and fingerprints `public/` when it starts, so restart it after changing those files.

```sh
npm run check
npm test
```

For a real browser fallback test, keep the normal server running and run `node test/blocked-direct-proxy.mjs`. Open http://localhost:3478 in two browser tabs. The fixture suppresses initial WebRTC signaling so the production browser code must fall back to the encrypted relay after eight seconds. This test fixture is not deployed.

For a repeatable latency benchmark, run `node test/latency-proxy.mjs` with the normal server running. Open http://localhost:3479 and receive its complete link with the Node client. The fixture adds 50 ms per WebSocket hop, producing approximately 200 ms of added round-trip latency between the two peers. It is not deployed.

## Branding and link previews

The two folded pieces in `public/logo.svg` form the Meatproxy M. `npm run build:brand` generates the matching SVG/PNG favicons, Apple touch icon, and 1200 × 630 social images from this mark, `brand/social.svg`, and `brand/handoff.svg`. The renderer is a development dependency; the server only serves the finished assets. The bundled Atkinson Hyperlegible fonts are licensed under the [SIL Open Font License](brand/fonts/OFL.txt), sourced from [Google Fonts](https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegible).

The page includes [Open Graph](https://ogp.me/) metadata and a large-image Twitter/X card. Handoff previews use the room URL without its secret fragment and show whether the sender is online, busy, or offline when fetched, plus file count and total size. **Show filenames in preview** is off by default. Enabling it publishes up to three filenames (shortened for previews) to the server and anyone with the room URL, including chat apps. Turning it off removes names from subsequent responses, but cannot erase copies already cached by a chat app. The server reads the sender's messages in order, so during a relayed transfer the change takes effect only after file data already sent ahead of it has been delivered, which can take tens of seconds on a slow or stalled connection. Notes, file contents, and encryption keys never appear in previews.

Preview metadata is held only in room memory and removed when the sender leaves. Fetching the HTML or `/s/:room/status` never joins the transfer or occupies the recipient slot. Before acceptance, the receiving page checks availability every ten seconds; the actual join checks availability again. This is a connection-status check, not a guarantee that a backgrounded sender can transfer immediately. Chat previews are snapshots and may remain cached (for example, [Slack caches unfurls](https://api.slack.com/robots)). `robots.txt` permits preview fetching; handoff pages and their status responses retain `noindex, nofollow` and `Cache-Control: no-store`.

## Transfer design

- A 128-bit random room ID locates a live sender. A separate 256-bit key is carried in the URL fragment; the application never transmits that key to the server.
- AES-GCM encrypts signaling, the transfer manifest, notes, and file chunks. Filenames are also published separately only when the sender opts into filename previews. Each encrypted packet uses a random 96-bit IV; data packets also bind the room, fresh connection ID, direction, and ordered sequence.
- The browser tries an ordered WebRTC data channel using Cloudflare's public STUN service. If the connection cannot be established within eight seconds, the same encrypted payloads travel over a WebSocket relay. No TURN account is required.
- Files are read in 1 MiB blocks and streamed in 16 KiB encrypted chunks. Receivers acknowledge each 256 KiB; senders pipeline these acknowledgements with at most 4 MiB outstanding on either transport. When a relayed receiver falls behind, the relay stops reading from the sender until the receiver catches up, so TCP slows the sender instead of the relay buffering or disconnecting it. Any message from a socket counts as a sign of life, because a slow upload can hold the reply to a liveness check behind queued file data. After a receiver leaves, the relay drops the sender's data until the sender's first signal for the next receiver, so a new receiver never gets ciphertext meant for the previous one. The new receiver's connection waits until that data has crossed the sender's upload, which can take tens of seconds on a slow connection; the command-line receiver gives up after 60 seconds without activity. The sender's acknowledgement deadline is 30 seconds since the last acknowledgement, not since each chunk was sent, so a slow link draining a full window does not time out. A transfer also stops if 30 seconds pass without the sender's WebSocket or data-channel buffer draining. Files that fit the window stream through to the final checksum without stopping for intermediate acknowledgements. Direct transfers resume on WebRTC's buffer-drain event instead of polling a timer. Every completed file is SHA-256 verified. WebSocket and data-channel buffers remain bounded.
- The relay never writes transferred files to disk. Room state is in process memory. The Nginx vhost disables access logs; error logs can still contain connection metadata. Cloudflare may retain traffic metadata under the account's policies.
- Anyone holding the complete link can receive the handoff. This is a capability link, not verified recipient identity. The web application and code delivered by the origin/Cloudflare remain trusted; encryption does not protect against a compromised application delivering malicious JavaScript.
- Direct WebRTC can expose network addresses to the other peer; see [WebRTC IP address handling](https://www.rfc-editor.org/rfc/rfc8828). Falling back to a relay after trying direct does not retract addresses already shared during connection setup. A relay-only mode would need to avoid direct setup from the start; this version defaults to direct and has no such privacy switch. Relaying adds a server path and bandwidth costs, but does not inherently halve throughput because data is forwarded as it arrives.
- Public resource limits: at most 200 connected sockets, 64 KiB per WebSocket message, relay buffering that pauses a sender once 512 KiB or 256 messages are waiting for its receiver, a 12-hour room lifetime, and a 10-second initial handshake deadline. The service has CPU and memory limits to protect the shared host.

## Hosting

Run the app as its own unprivileged service behind an HTTPS reverse proxy. It listens on `127.0.0.1:3477` by default; set `PORT` to change the port and `PUBLIC_ORIGIN` to the public HTTPS origin. Forward WebSocket upgrades for `/socket`, disable proxy buffering and caching, and allow idle WebSocket connections for at least 90 seconds. Use `/healthz` for health checks.

Pages reference scripts, styles, and images as `/file?v=<version>`, where the version is the start of a SHA-256 over the response headers and the file after its own references are versioned. A module's version therefore changes when anything it imports changes. Only a request for the current version gets `Cache-Control: public, max-age=31536000, immutable`, which lets browsers keep it; Cloudflare's default rules also cache the `.js`, `.css`, `.png`, and `.svg` files, but not `.mjs` or `.txt`. Pages, status responses, and unversioned or outdated asset URLs stay `no-store`. Each release computes versions from its own files when the service starts, so a deploy gives every changed file a new URL without purging any cache. Versions cover only headers the application sets; after changing headers that Nginx or Cloudflare add to responses, purge Cloudflare's cache. Versioned URLs depend on Cloudflare including the query string in its cache key, as its default caching level does. `/receive.mjs` stays available without a version for the command-line download.

Cloudflare can proxy the domain and terminate public TLS. Use **Full (Strict)** with a valid certificate at the origin. Keep the application process and virtual host separate from other sites. A service restart ends active rooms, so preserve the previous release for rollback.

Machine-specific deployment notes, host inventories, test artifacts, credentials, and local backups are excluded from this repository.
