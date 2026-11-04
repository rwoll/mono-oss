# The Blobby desktop image: Ubuntu 24.04 with the GNOME 46 "Ubuntu" session on TigerVNC, noVNC, the
# command sandbox's packages, developer tools, screen capture, accessibility, and Node.js with
# playwright-core for feature steps. Redistributable software only: features install Google Chrome and
# VS Code Insiders when a sandbox is set up, never this image. See README.md.
#
# Build it with `node images/desktop/build.ts`, which tags it blobby-desktop:<content hash> and passes
# the npm registry from the repository's .npmrc.

# ubuntu:24.04, pinned to its multi-architecture index (amd64 and arm64).
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

ARG DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# The GNOME Shell (Mutter) "Ubuntu" session as on Ubuntu Desktop, without gdm3, Snap, or the rest of
# ubuntu-desktop: the Ubuntu Dock and Yaru theme, a terminal, Files, Settings (which GNOME Shell needs),
# the session bus and dconf, accessibility (AT-SPI), fonts for every script and emoji, the VNC server,
# and websockify for the viewer. Also tini, sudo, and what fetches vendor signing keys.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      gnome-shell gnome-session ubuntu-session ubuntu-settings gnome-shell-extension-ubuntu-dock \
      yaru-theme-gnome-shell yaru-theme-gtk yaru-theme-icon gnome-terminal nautilus gnome-control-center \
      gjs librsvg2-common dbus-x11 dconf-cli libglib2.0-bin x11-xserver-utils at-spi2-core python3-pyatspi \
      fonts-ubuntu fonts-dejavu-core fonts-noto-cjk fonts-noto-color-emoji \
      tigervnc-standalone-server tigervnc-tools websockify \
      tini sudo ca-certificates curl gpg \
 && rm -rf /var/lib/apt/lists/*

# Developer tools; what VS Code's and Copilot's command sandbox needs (bubblewrap, and socat,
# slirp4netns, and iptables for its network); desktop automation and screenshots; recording with
# ffmpeg (H.264) and GStreamer (VP8 and WebM); and Vulkan for machines with a GPU.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client less build-essential pkg-config python3-pip python3-venv python-is-python3 \
      unzip zip xz-utils wget jq ripgrep file nano vim-tiny procps lsof iproute2 iputils-ping \
      bubblewrap socat slirp4netns iptables \
      xdotool wmctrl scrot \
      ffmpeg gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-x \
      gir1.2-gstreamer-1.0 python3-gi \
      mesa-vulkan-drivers libvulkan1 vulkan-tools \
 && rm -rf /var/lib/apt/lists/*

# noVNC's web app (MPL-2.0), for `websockify --web`. Only its files: the package's dependencies run it
# as a service, which the session doesn't need.
RUN apt-get update \
 && mkdir /tmp/novnc \
 && chown _apt /tmp/novnc \
 && cd /tmp/novnc \
 && apt-get download novnc \
 && dpkg-deb -x novnc_*.deb root \
 && cp -rL root/usr/share/novnc /usr/share/novnc \
 && install -D -m 0644 root/usr/share/doc/novnc/copyright /usr/share/doc/novnc/copyright \
 && cd / \
 && rm -rf /tmp/novnc /var/lib/apt/lists/*

# Node.js and playwright-core for feature steps, such as signing in, at the paths blobby-sandbox's
# runtime uses. Both are pinned and checked against their published checksums: Node.js from
# nodejs.org/dist/v22.23.4/SHASUMS256.txt, and playwright-core against its registry integrity, which
# pnpm-lock.yaml records too. The registry comes in as a build secret only so that its host stays out
# of the image's history; the checksum, not the registry, decides what's installed.
ARG NODE_VERSION=22.23.4
ARG NODE_SHA256_AMD64=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406
ARG NODE_SHA256_ARM64=f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9
ARG PLAYWRIGHT_CORE_VERSION=1.58.2
ARG PLAYWRIGHT_CORE_SHA512=c99904b5fb60c12f02b1f628ee79b4284f23b2f9ba8bf3d3815b41f032fbdbac0d7fa1f620cb03bb10a9263e7d2836b10ad4a7ad66a7d80783a8cec905aba5b6
RUN --mount=type=secret,id=npm-registry \
    set -eu; \
    registry=$(cat /run/secrets/npm-registry 2>/dev/null || true); \
    case "$registry" in \
      https://*) ;; \
      *) echo "blobby-desktop: pass the npm registry as the npm-registry build secret (build.ts does)." >&2; exit 1 ;; \
    esac; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64; sum=$NODE_SHA256_AMD64 ;; \
      arm64) arch=arm64; sum=$NODE_SHA256_ARM64 ;; \
      *) echo "blobby-desktop: the image is for amd64 and arm64 only." >&2; exit 1 ;; \
    esac; \
    curl -fsSL --proto '=https' --retry 3 -o /tmp/node.tar.gz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.tar.gz"; \
    echo "$sum  /tmp/node.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/blobby/node /opt/blobby/node_modules/playwright-core; \
    tar -xzf /tmp/node.tar.gz -C /opt/blobby/node --strip-components=1 --no-same-owner \
      --exclude='*/include' --exclude='*/share' --exclude='*/lib/node_modules' \
      --exclude='*/bin/npm' --exclude='*/bin/npx' --exclude='*/bin/corepack'; \
    curl -fsSL --proto '=https' --retry 3 -o /tmp/playwright-core.tgz \
      "${registry%/}/playwright-core/-/playwright-core-$PLAYWRIGHT_CORE_VERSION.tgz"; \
    echo "$PLAYWRIGHT_CORE_SHA512  /tmp/playwright-core.tgz" | sha512sum -c -; \
    tar -xzf /tmp/playwright-core.tgz -C /opt/blobby/node_modules/playwright-core --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.gz /tmp/playwright-core.tgz

# Configuration, launchers, and the feature-support scripts in /opt/blobby/image (see README.md).
COPY rootfs/ /

# The desktop user, uid 1000 like on Ubuntu Desktop, with passwordless sudo. Sandboxes that may not
# become root run with no-new-privileges, which stops sudo. The image has no systemd, logind, or
# display manager; runtime/boot.sh and session.sh start the session.
ARG BLOBBY_IMAGE_HASH=unknown
RUN set -eu; \
    getent group render >/dev/null || groupadd --system render; \
    usermod -aG sudo,video,render ubuntu; \
    chmod 0440 /etc/sudoers.d/blobby; \
    dconf update; \
    ln -s google-chrome-stable /usr/local/bin/google-chrome; \
    rm -rf /run/systemd/seats /run/systemd/sessions /run/systemd/users /run/reboot-required*; \
    runuser -u ubuntu -- sh -c 'mkdir -p ~/.local/share/gnome-shell && touch ~/.local/share/gnome-shell/lock-warning-shown'; \
    printf '%s\n' '# The Blobby desktop image (images/desktop). Read it to see what the image provides.' \
      BLOBBY_IMAGE=desktop "BLOBBY_IMAGE_HASH=$BLOBBY_IMAGE_HASH" \
      "BLOBBY_NODE_VERSION=$NODE_VERSION" "BLOBBY_PLAYWRIGHT_CORE_VERSION=$PLAYWRIGHT_CORE_VERSION" >/etc/blobby/image; \
    /opt/blobby/image/bin/check

LABEL blobby.dev/image=desktop \
      org.opencontainers.image.title="Blobby desktop" \
      org.opencontainers.image.description="Ubuntu 24.04 GNOME desktop for Blobby sandboxes, with redistributable software only" \
      org.opencontainers.image.source=https://github.com/rwoll/mono-oss \
      org.opencontainers.image.licenses=MIT \
      org.opencontainers.image.base.name=docker.io/library/ubuntu:24.04 \
      org.opencontainers.image.base.digest=sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

# The viewer: websockify serves noVNC and the VNC server here once the session runs.
EXPOSE 6901
# Docker runs tini as PID 1, which reaps the session's orphaned processes. The command only waits;
# blobby-sandbox starts the session with `/opt/blobby/runtime/boot.sh <resolution>`, which works the
# same where the image boots as a machine and nothing runs this entry point.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/usr/local/bin/blobby-desktop", "idle"]
