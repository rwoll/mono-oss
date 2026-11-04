#!/bin/bash
# Starts the desktop once per boot: runs the recipe's boot.sh, then starts the session as the desktop
# user. Runs as root. Prints `blobby-boot: <started|running>`, and passes on the recipe's
# `blobby-info: <key> <value>` lines.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
here=$(cd "$(dirname "$0")" && pwd)
recipe=/opt/blobby/recipe
resolution=${1:-1280x800}
case "$resolution" in [1-9]*x[1-9]*) ;; *) resolution=1280x800 ;; esac

if pgrep -u ubuntu -f "^/bin/bash /opt/blobby/(runtime|guest)/session.sh" >/dev/null; then
  echo "blobby-boot: running"
  exit 0
fi

# An earlier stop can leave a package half installed.
dpkg --configure -a >/dev/null 2>&1 || true
# The recipe's boot.sh runs before anything can start its apps, for example to update them.
if [ -x "$recipe/boot.sh" ]; then
  "$recipe/boot.sh" || echo "blobby-boot: the recipe's boot.sh failed; the desktop starts anyway" >&2
fi

# The GPU's device nodes are root's at boot. Vulkan apps get the GPU through the render group.
if [ -d /dev/dri ]; then chgrp render /dev/dri/* && chmod 0660 /dev/dri/*; fi
install -d -m 0700 -o ubuntu -g ubuntu /run/user/1000
install -d -m 1777 /tmp/.X11-unix /tmp/.ICE-unix
if ! mountpoint -q /dev/shm; then mkdir -p /dev/shm && mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /dev/shm; fi
# Chrome and VS Code windows crash with too little shared memory, and some platforms, such as Azure
# sandboxes, mount only 64 MB. tmpfs takes memory only as it fills.
if [ "$(df --output=size -k /dev/shm | tail -n 1)" -lt 524288 ]; then
  mount -o remount,size=1g /dev/shm || echo "blobby-boot: /dev/shm is small, and could not be enlarged; browsers may crash" >&2
fi
# Chromium's sandbox, in Chrome and in Electron apps such as VS Code, needs user namespaces, or its
# setuid helper with root's CAP_SYS_ADMIN and without no-new-privileges. Containers such as Docker's
# give it neither, and those apps then exit at launch. Their launchers add --no-sandbox when this file
# exists, so only machines that can't run the sandbox go without it.
can_sandbox() {
  runuser -u ubuntu -- unshare --user --map-root-user true 2>/dev/null && return 0
  grep -q '^NoNewPrivs:[[:space:]]*0$' /proc/self/status || return 1
  local caps
  caps=$(awk '/^CapBnd:/ { print $2 }' /proc/self/status)
  [ -n "$caps" ] && [ $(( (0x$caps >> 21) & 1 )) -eq 1 ]
}
install -d /etc/blobby
if can_sandbox; then
  rm -f /etc/blobby/no-chromium-sandbox
else
  touch /etc/blobby/no-chromium-sandbox
  echo "blobby-boot: this machine can't run Chromium's sandbox, so Chrome and Electron apps such as VS Code run without it" >&2
fi
# Each desktop gets its own viewer password the first time it starts. VNC uses only the first 8 characters.
if [ ! -s /etc/blobby/vnc-password ]; then
  (umask 077 && python3 -c 'import secrets, string; print("".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8)), end="")' >/etc/blobby/vnc-password)
fi
runuser -u ubuntu -- sh -c 'umask 077 && mkdir -p ~/.vnc && vncpasswd -f > ~/.vnc/passwd' </etc/blobby/vnc-password
# The desktop user runs the session from this folder, which only root can change.
chmod 0755 "$here" "$(dirname "$here")"
setsid runuser -u ubuntu -- "$here/session.sh" "$resolution" >/var/log/blobby-session.log 2>&1 </dev/null &
echo "blobby-boot: started"
