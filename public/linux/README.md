# Opcode Linux

Files for the Linux projects (see `toolchains/linux/` for how they are built):

- `opcode-linux.state`: a gzip-compressed v86 snapshot of Opcode Linux taken right after boot. It contains Alpine Linux 3.24 (x86) and the `linux-virt` kernel, booted with the root filesystem in memory. It only works with the v86 version recorded in `manifest.json`.
- `seabios.bin`, `vgabios.bin`: SeaBIOS and the VGA BIOS from the [v86 project](https://github.com/copy/v86/tree/master/bios) (LGPL-3.0).

## Licenses and source code

The snapshot contains software under many open source licenses, including the Linux kernel (GPL-2.0), BusyBox (GPL-2.0), musl (MIT), bash, coreutils and other GNU tools (GPL-3.0). It is built only from unmodified Alpine Linux packages:

- Package list and build steps: `toolchains/linux/build.sh`
- Alpine package sources: https://gitlab.alpinelinux.org/alpine/aports (branch `3.24-stable`)
- Linux kernel source: https://kernel.org (Alpine's `linux-virt` patches are in aports `main/linux-lts`)
