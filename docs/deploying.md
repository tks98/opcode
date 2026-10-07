[← Documentation](README.md)

# Deploying

## With Docker

The Docker image runs Opcode with a small server that sends the headers Opcode needs, serves files compressed ahead of time (Clang's 76 MB compiler downloads as 17 MB), and can also be its internet relay and web preview host, all on one port. Every push to `main` publishes it as `ghcr.io/tks98/opcode`:

```bash
docker run --rm -p 8080:8080 ghcr.io/tks98/opcode
```

Then open http://localhost:8080. The image is about 1.2 GB (a 500 MB download), mostly the toolchains and the Linux and Docker machines. To build it yourself from this repository (a few minutes; it downloads the toolchains the build needs), `docker build -t opcode .` and run `opcode` instead.

Browsers only run Opcode on secure pages. `http://localhost` counts, but other computers reaching the server at `http://` don't, so a server for others needs HTTPS in front of it. `compose.yaml` does that with [Caddy](https://caddyserver.com/), which gets certificates from Let's Encrypt. Point DNS for your domain and for `preview.` your domain at the server, open ports 80 and 443, then:

```bash
OPCODE_DOMAIN=opcode.example.com docker compose up -d
```

The image is configured with environment variables (`docker run -e`, or `environment:` in `compose.yaml`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | The port the server listens on |
| `OPCODE_RELAY` | `off` | `on` gives terminals and Linux machines internet access through a relay on this server, at `/wisp/` (read [Internet relay](deploying.md#internet-relay) first). A `wss://` address uses that relay instead. With `off`, users can still pick a relay in the *Internet* settings. |
| `OPCODE_RELAY_ARGS` | | The built-in relay's options, as `scripts/wisp-server.mjs` takes them: `--max-streams 32 --via-proxy http://proxy:3128` |
| `OPCODE_RELAY_ORIGINS` | | Other sites whose pages may use the built-in relay (comma-separated). Pages of this site always may. |
| `OPCODE_PREVIEW_HOST` | Wasmer's host | Serve the [web preview host](deploying.md#web-preview-host) here, to requests for that address: `https://preview.example.com/`, or `https://*.preview.example.com/` for one address per server (needs wildcard DNS and a wildcard certificate, which `compose.yaml`'s Caddy can't get by itself) |

Everything on one computer, with an address for each preview (Chrome and Firefox resolve every `*.localhost` name without DNS):

```bash
docker run --rm -p 8080:8080 -e OPCODE_RELAY=on -e OPCODE_PREVIEW_HOST='http://*.localhost:8080/' ghcr.io/tks98/opcode
```

Behind a reverse proxy of your own, pass the `Host` header on (Caddy does; in nginx, `proxy_set_header Host $host`, plus the WebSocket upgrade headers for `/wisp/`), and serve Opcode at the root of its domain: the built-in relay answers DNS at `/dns-query`. The server is `scripts/server.mjs`; without Docker, `npm run build && npm run build:preview-host && node scripts/precompress.mjs && npm start` runs it the same way.

## Static hosting

`npm run build` produces a static site in `dist/` that works from any path. The runtime needs [cross-origin isolation](https://web.dev/articles/coop-coep) (`SharedArrayBuffer`), so the page must be served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- **Rust**: `npm run build` first downloads the Rust toolchain (`scripts/fetch-rust.mjs`: a pinned, checksummed release of [`oligamiq/rust_wasm`](https://github.com/oligamiq/rust_wasm), MIT OR Apache-2.0) into `public/toolchains/rust/` (not in git). It needs network access once; set up a cache of that folder for CI.
- **Java**: `npm run build` also builds Java's class library files (`scripts/fetch-java.mjs`) from a pinned, checksummed Amazon Corretto 21 JDK, downloaded once into `node_modules/.cache/opcode-java/` (about 210 MB; CI caches it).
- **Netlify / Cloudflare Pages**: `public/_headers` is included.
- **Vercel**: `vercel.json` is included.
- **GitHub Pages**: `.github/workflows/pages.yml` builds and publishes every push to `main` (turn it on in *Settings > Pages* with *Source: GitHub Actions*). Pages, like other hosts without custom headers, can't send the headers, so `coi-serviceworker.js` adds them on the first visit and reloads the page once.
- **Settings without rebuilding**: `dist/config.js` (from `public/config.js`) can set the internet relay and the web preview host, below, in place of the `VITE_*` variables the build reads.

## Internet relay

Browsers can't open network connections, so terminals and Linux machines tunnel theirs over a WebSocket to a [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) relay, which makes the real connections and answers their DNS lookups (DNS-over-HTTPS at `/dns-query`). Without a relay, everything works except internet access. `scripts/wisp-server.mjs` is a small relay:

```bash
npm install
node scripts/wisp-server.mjs --host 0.0.0.0 --port 8090 --origin https://your-opcode-site
 behind TLS (a reverse proxy, or a host such as Fly.io or Render), then build the app with:
VITE_WISP_URL=wss://relay.your-site/ npm run build
```

(or set `relay: 'wss://relay.your-site/'` in `config.js`; the Docker image can also run the relay itself, with `OPCODE_RELAY=on`).

It listens on `127.0.0.1` unless given `--host`. Reachable from the internet, it is an open relay: `--origin` only stops other websites' pages from using it (any other program can send the header it expects), so run it where outgoing traffic from strangers is acceptable. It refuses private and local addresses (your network, cloud metadata endpoints) and outgoing mail ports by default (`--allow-private`, `--block-ports 25,465,587`), and limits streams per connection (`--max-streams`). `--via-proxy http://proxy:3128` sends connections through an HTTP proxy. Students or teachers can also point a copy of Opcode at a relay in the *Internet* settings in the status bar (saved in their browser). `npm run relay` starts one locally on port 8090 for development (`VITE_WISP_URL=ws://localhost:8090/ npm run dev`).

The production build includes the Wasmer SDK's own dependency for this, the Wisp client [`@mercuryworkshop/wisp-js`](https://github.com/MercuryWorkshop/wisp-client-js) (AGPL-3.0 in the version the SDK uses), bundled as `wasmer-sdk/deps/wisp-client.js`.

## Web preview host

The preview reaches servers inside the sandbox through a service worker on a separate origin. A server owns that whole origin, so one origin can show one server at a time. By default Opcode uses Wasmer's `https://default.local.wasmer.site/`, which works like that.

To host your own, run `npm run build:preview-host` and deploy `dist-preview-host/` to an origin other than the app's (it includes `_headers`, and `.nojekyll` for GitHub Pages):

- **One origin** (one preview at a time): build the app with `VITE_PREVIEW_HOST=https://preview.example.com/ npm run build` (or set `previewHost` in `config.js`; the Docker image serves the host itself, with `OPCODE_PREVIEW_HOST`).
- **A wildcard origin** (one address per server, any number at once): serve the same files on every subdomain, with wildcard DNS and a wildcard certificate, and build with `VITE_PREVIEW_HOST=https://*.preview.example.com/ npm run build`. Each server gets a random name such as `https://p3k9x0q2m.preview.example.com/`. On Cloudflare, deploy `dist-preview-host/worker.js` as a Worker routed to `*.preview.example.com/*` (it holds the files itself).

`npm run preview-host` serves the host locally on port 5174, on `localhost` and every `*.localhost` subdomain, which Chrome resolves without DNS setup: `VITE_PREVIEW_HOST='http://*.localhost:5174/' npm run dev` gives per-server addresses in development (the Playwright tests use that).

Some files in the build are large: `llvm.core.wasm` (~76 MB), `linux-docker/opcode-docker.state.*` (three parts of up to 45 MB), `linux/opcode-linux.state` (~42 MB), `llvm-resources.tar` (~30 MB), `toolchains/rust/rustc.wasm.gz` (~30 MB) and `toolchains/rust/sysroot.tar.gz` (~27 MB). Hosts with a per-file size limit (Cloudflare Pages allows 25 MiB) can't serve them. Netlify, Vercel, GitHub Pages or your own server work. Enable compression for `.wasm` files.
