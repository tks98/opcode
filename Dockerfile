# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
#
# Opcode, ready to deploy: the app, its web preview host and an optional
# internet relay, served by one small Node server (scripts/server.mjs).
#
#   docker build -t opcode .
#   docker run --rm -p 8080:8080 opcode       # then open http://localhost:8080
#
# Settings are environment variables (OPCODE_RELAY, OPCODE_PREVIEW_HOST...):
# see docs/deploying.md, and compose.yaml for a site with
# HTTPS.

# The build. The toolchains `npm run build` downloads (pinned and checksummed:
# Rust, a JDK for Java, NuGet packages for C#, the Wasmer packages) are cached
# between builds.
#
# The base images (and the syntax line above) are pinned by digest, so a
# build uses exactly what was tested. To update one, take the digest from
# `docker buildx imagetools inspect node:22-bookworm-slim` (or node:22-alpine,
# docker/dockerfile:1).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /opcode
# Stop if a toolchain can't be downloaded, rather than build without it.
ENV CI=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN --mount=type=cache,target=/opcode/node_modules/.cache \
    --mount=type=cache,target=/opcode/public/toolchains/rust \
    --mount=type=cache,target=/opcode/public/wasmer \
    npm run build \
 && node scripts/preview-host.mjs \
 && node scripts/precompress.mjs dist dist-compressed

# What runs: Node, the server (whose relay needs the ws package) and the build.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
LABEL org.opencontainers.image.title="Opcode" \
      org.opencontainers.image.description="A browser IDE with a real terminal, running on WebAssembly" \
      org.opencontainers.image.source="https://github.com/tks98/opcode" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
WORKDIR /opcode
ENV NODE_ENV=production PORT=8080
COPY --from=build /opcode/LICENSE /opcode/THIRD_PARTY_NOTICES.md ./
COPY --from=build /opcode/node_modules/ws node_modules/ws
COPY --from=build /opcode/scripts/server.mjs /opcode/scripts/wisp-server.mjs scripts/
COPY --from=build /opcode/dist-preview-host dist-preview-host
COPY --from=build /opcode/dist-compressed dist-compressed
COPY --from=build /opcode/dist dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "scripts/server.mjs"]
