# syntax=docker/dockerfile:1
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
# Rust, a JDK for Java, NuGet packages for C#) are cached between builds.
FROM node:22-bookworm-slim AS build
WORKDIR /opcode
# Stop if a toolchain can't be downloaded, rather than build without it.
ENV CI=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN --mount=type=cache,target=/opcode/node_modules/.cache \
    --mount=type=cache,target=/opcode/public/toolchains/rust \
    npm run build \
 && node scripts/preview-host.mjs \
 && node scripts/precompress.mjs dist dist-compressed

# What runs: Node, the server (whose relay needs the ws package) and the build.
FROM node:22-alpine
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
