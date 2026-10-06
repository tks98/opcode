# Opcode Docker

Files for the Docker projects (see `toolchains/linux/` for how they are built):

- `opcode-docker.state.1`, `.2`, `.3`: a gzip-compressed v86 snapshot of Opcode Docker taken right after boot, split into parts (join them in order). It is Opcode Linux (Alpine Linux 3.24, x86) plus Docker Engine, the Docker CLI and Docker Compose, with Docker running and a few images loaded. It only works with the v86 version recorded in `manifest.json`, which also lists the parts.
- The BIOS files are shared with Opcode Linux (`../linux/`).

## Licenses and source code

Besides what `../linux/README.md` lists, the snapshot contains Docker Engine (Moby), the Docker CLI, Docker Compose, containerd and runc (all Apache-2.0), from unmodified Alpine Linux packages:

- Package list and build steps: `toolchains/linux/build.sh` (the `docker` variant)
- Alpine package sources: https://gitlab.alpinelinux.org/alpine/aports (branch `3.24-stable`, `community/docker`, `community/containerd`, `community/runc`, `community/docker-cli-compose`)

It also contains these Docker Official Images (32-bit x86 builds, pinned by digest in `toolchains/linux/fetch-images.mjs`), each under the licenses of the software inside: `hello-world`, `alpine` (Alpine Linux), `busybox` (BusyBox, GPL-2.0) and `nginx:alpine-slim` (nginx, BSD-2-Clause, on Alpine Linux). Their sources are linked from https://github.com/docker-library.
