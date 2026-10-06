#!/bin/bash
# Builds Opcode Linux: an Alpine Linux system that boots in the browser on
# the v86 x86 emulator. Outputs (in toolchains/linux/out/, or out-docker/):
#
#   vmlinuz             Alpine's linux-virt kernel (32-bit x86)
#   initramfs.cpio.gz   the whole root filesystem, unpacked into RAM at boot
#
# These are inputs for make-state.mjs, which boots them and saves the
# snapshot the app actually ships (public/linux/opcode-linux.state).
#
# The docker variant (Opcode Docker) adds Docker Engine, its command line
# tools and Compose, the kernel modules containers need (overlay, bridge,
# veth, netfilter) and a few small container images.
#
# Requirements: Linux (x86_64 or x86, able to run 32-bit binaries), root
# (packages run their install scripts in a chroot), curl, gzip, sha256sum,
# and Node.js for the docker variant's images.
# Usage: sudo toolchains/linux/build.sh [docker]
set -euo pipefail

VARIANT=${1:-linux}
case "$VARIANT" in
  linux | docker) ;;
  *) echo "Unknown variant: $VARIANT (expected linux or docker)" >&2; exit 1 ;;
esac

ALPINE_VERSION=3.24.2
ALPINE_BRANCH=v3.24
MIRROR=${ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine}

# What students get. Keep it focused: tools for learning the command line.
PACKAGES=(
  bash bash-completion coreutils findutils grep sed gawk diffutils patch
  less nano vim tree htop procps-ng psmisc util-linux-misc
  shadow sudo tar gzip xz zip unzip bzip2 tmux git figlet
  curl ca-certificates openssh-client-default
  mandoc man-pages
  bash-doc coreutils-doc findutils-doc grep-doc sed-doc gawk-doc diffutils-doc
  less-doc nano-doc tree-doc htop-doc procps-ng-doc psmisc-doc tar-doc
  gzip-doc sudo-doc tmux-doc git-doc shadow-doc curl-doc
)

# Kernel modules the machine needs (the kernel has the rest built in): the
# virtio network card, and packet sockets for the DHCP client.
MODULES=(net/core/failover drivers/net/net_failover drivers/net/virtio_net net/packet/af_packet)

# Opcode Docker. (No buildx: `docker build` uses the classic builder, which
# is lighter; `sudo apk add docker-cli-buildx` installs BuildKit's.)
DOCKER_PACKAGES=(docker-engine docker-cli docker-cli-compose docker-bash-completion kmod)
# Kernel modules containers need, with what they depend on: overlay
# filesystems for image layers, bridges and veth pairs for container
# networks, and netfilter (nftables, which iptables uses) for NAT and -p.
DOCKER_MODULES=(fs/overlayfs net/bridge net/802 net/llc drivers/net/veth.ko.gz net/netfilter net/ipv4/netfilter net/ipv6/netfilter)

here=$(cd "$(dirname "$0")" && pwd)
if [ "$VARIANT" = docker ]; then
  PACKAGES+=("${DOCKER_PACKAGES[@]}")
  out=${OUT_DIR:-$here/out-docker}
else
  out=${OUT_DIR:-$here/out}
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
rootfs=$work/rootfs
mkdir -p "$rootfs" "$out"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (package install scripts need chroot)." >&2
  exit 1
fi

echo "==> Downloading Alpine $ALPINE_VERSION (x86)"
tarball=alpine-minirootfs-$ALPINE_VERSION-x86.tar.gz
curl -fsSL -o "$work/$tarball" "$MIRROR/$ALPINE_BRANCH/releases/x86/$tarball"
expected=$(curl -fsSL "$MIRROR/$ALPINE_BRANCH/releases/x86/$tarball.sha256" | cut -d' ' -f1)
echo "$expected  $work/$tarball" | sha256sum -c -
tar -xzf "$work/$tarball" -C "$rootfs"

host_arch=$(uname -m)
apk_tools=$(curl -fsSL "$MIRROR/$ALPINE_BRANCH/main/$host_arch/" | grep -o 'apk-tools-static-[^"]*\.apk' | sort -V | tail -1)
curl -fsSL -o "$work/apk-tools.apk" "$MIRROR/$ALPINE_BRANCH/main/$host_arch/$apk_tools"
tar -xzf "$work/apk-tools.apk" -C "$work" sbin/apk.static 2>/dev/null
apk() {
  "$work/sbin/apk.static" --arch x86 --keys-dir "$rootfs/etc/apk/keys" \
    -X "$MIRROR/$ALPINE_BRANCH/main" -X "$MIRROR/$ALPINE_BRANCH/community" "$@"
}

echo "==> Installing packages"
apk --root "$rootfs" --update-cache add "${PACKAGES[@]}"

echo "==> Extracting the kernel"
kernel_root=$work/kernel
mkdir -p "$kernel_root/etc/apk"
cp -r "$rootfs/etc/apk/keys" "$kernel_root/etc/apk/"
apk --root "$kernel_root" --initdb --no-scripts --update-cache add linux-virt
cp "$kernel_root/boot/vmlinuz-virt" "$out/vmlinuz"
kernel_version=$(ls "$kernel_root/lib/modules")
mkdir -p "$rootfs/lib/modules/opcode"
for module in "${MODULES[@]}"; do
  # Loaded with insmod in order (see opcode-boot), so no modules.dep needed.
  gunzip -c "$kernel_root/lib/modules/$kernel_version/kernel/$module.ko.gz" > "$rootfs/lib/modules/opcode/$(basename "$module").ko"
done
if [ "$VARIANT" = docker ]; then
  # Installed the usual way, so modprobe (and the kernel, on demand) finds them.
  modules=$rootfs/lib/modules/$kernel_version
  for path in "${DOCKER_MODULES[@]}"; do
    mkdir -p "$modules/kernel/$(dirname "$path")"
    cp -a "$kernel_root/lib/modules/$kernel_version/kernel/$path" "$modules/kernel/$path"
  done
  cp "$kernel_root/lib/modules/$kernel_version"/modules.{order,builtin,builtin.modinfo} "$modules/"
  chroot "$rootfs" depmod "$kernel_version"
fi

echo "==> Configuring the system"
cp -a "$here/overlay/." "$rootfs/"
if [ "$VARIANT" = docker ]; then
  cp -a "$here/overlay-docker/." "$rootfs/"
  # Loaded into Docker on the first boot (see opcode-docker), then deleted.
  mkdir -p "$rootfs/var/lib/opcode"
  node "$here/fetch-images.mjs" "$rootfs/var/lib/opcode/images.tar"
fi
cp -a "$here/home" "$work/home-template"
echo "$MIRROR/$ALPINE_BRANCH/main" > "$rootfs/etc/apk/repositories"
echo "$MIRROR/$ALPINE_BRANCH/community" >> "$rootfs/etc/apk/repositories"
ln -sf /sbin/init "$rootfs/init"

chroot "$rootfs" /bin/sh -e <<'EOF'
adduser -D -s /bin/bash -g "Student" student
addgroup student wheel
echo 'student:student' | chpasswd
echo 'root:root' | chpasswd
sed -i 's#^root:x:0:0:root:/root:/bin/sh#root:x:0:0:root:/root:/bin/bash#' /etc/passwd
makewhatis /usr/share/man 2>/dev/null || true
EOF
if [ "$VARIANT" = docker ]; then
  # Docker's socket belongs to the docker group: students use it without sudo.
  chroot "$rootfs" /bin/sh -e -c 'addgroup -S docker 2>/dev/null || true; addgroup student docker'
fi

echo "==> Creating the student's home directory"
home=$rootfs/home/student
cp -a "$work/home-template/." "$home/"
"$here/make-tutorial-files.sh" "$home/tutorial"
if [ "$VARIANT" = docker ]; then
  cp -a "$here/home-docker/." "$home/"
fi
chroot "$rootfs" chown -R student:student /home/student

echo "==> Trimming"
# Everything lives in RAM, so drop what learners won't read: GNU info pages
# (no reader installed), package docs, and vim's help/tutor/translations.
# Man pages stay.
rm -rf "$rootfs/var/cache/apk/"* "$rootfs/boot" \
  "$rootfs/usr/share/info" "$rootfs/usr/share/doc" \
  "$rootfs"/usr/share/vim/vim*/{doc,tutor,lang,spell,print}

echo "==> Packing the initramfs"
# gzip rather than xz: decompressing on the emulated CPU is twice as fast.
(cd "$rootfs" && chroot . /bin/sh -c 'find . -xdev | sort | cpio -o -H newc 2>/dev/null') \
  | gzip -9 > "$out/initramfs.cpio.gz"

du -sh "$rootfs" | sed 's/^/rootfs (unpacked): /'
ls -lh "$out/vmlinuz" "$out/initramfs.cpio.gz"
