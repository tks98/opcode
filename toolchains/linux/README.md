# Opcode Linux image

The Linux projects run Alpine Linux on the [v86](https://github.com/copy/v86) x86 emulator. This folder builds what the app ships as `public/linux/opcode-linux.state`: a snapshot of the machine taken right after it boots, so students don't wait for a cold boot.

```bash
sudo toolchains/linux/build.sh        # kernel + root filesystem → toolchains/linux/out/
node toolchains/linux/make-state.mjs  # boot it in headless Chromium → public/linux/
```

(`npm run build:linux` runs both.) The Docker machine is the same system plus Docker:

```bash
sudo toolchains/linux/build.sh docker        # → toolchains/linux/out-docker/
node toolchains/linux/make-state.mjs docker  # → public/linux-docker/ (1 GB of memory)
```

(`npm run build:docker`.) `build.sh` needs root on an x86/x86_64 Linux machine that can run 32-bit binaries, because Alpine's package scripts run in a chroot. `make-state.mjs` needs Playwright's Chromium (`npx playwright install chromium`).

**Re-run both after upgrading v86**: snapshots only load in the v86 version that made them (`tests/linux.test.js` checks this).

## What's inside

- `build.sh`: installs pinned-branch Alpine packages (bash, coreutils, man pages, nano, vim, htop, sudo, git, …) into the official minirootfs, adds the `student` user, and packs everything into an initramfs. The whole system runs from RAM.
- `overlay/`: files copied over the root filesystem:
  - `etc/inittab` (busybox init, auto-login on the virtio console `hvc0`)
  - `usr/local/sbin/opcode-boot` (mounts /proc, /sys, /dev, /tmp)
  - `usr/local/sbin/opcode-agent`, which talks to the app over the second console port: it sets the clock after a snapshot is restored, and `reboot`/`poweroff` requests go back to the app (rebooting starts a fresh machine)
  - `usr/local/bin/tutorial` (the interactive lessons)
- `home/` and `make-tutorial-files.sh`: the student's home directory and the tutorial's practice files.
- `make-state.mjs`: boots the image and saves the gzip-compressed snapshot plus `manifest.json`. Snapshots over 45 MB are split into parts (`opcode-docker.state.1`, `.2`, …, listed in the manifest) so they fit git hosting limits; the app downloads and joins them.

The Docker machine adds:

- Alpine's `docker-engine`, `docker-cli`, `docker-cli-compose` and `kmod` packages, and the kernel modules containers need (overlayfs, bridge, veth, netfilter) installed under `/lib/modules` with `depmod`.
- `overlay-docker/`: `usr/local/sbin/opcode-docker` (run by `opcode-boot`: loads the modules, mounts cgroup2 and a tmpfs for `/var/lib/docker`, starts `dockerd` with `DOCKER_RAMDISK=true` because containers can't `pivot_root` out of an initramfs, and loads the bundled images), `etc/docker/daemon.json`, and `usr/local/bin/tutorial` (Docker lessons in place of the Linux ones).
- `home-docker/`: the examples in the student's home (`hello-web`, `compose-demo`).
- `fetch-images.mjs`: downloads the bundled images (32-bit x86, pinned by digest) from Docker Hub as a `docker load` archive. `node toolchains/linux/fetch-images.mjs --latest` prints current digests.

The agent (`opcode-agent`) also reports which TCP ports have a server listening, so the app can offer a preview; the preview reaches them through v86's network stack.

Boot parameters worth knowing: `initramfs_options=size=85%` (the default cap on the in-memory root filesystem is smaller than the system) and `init_on_free=1` (zeroes freed memory so snapshots compress well).
