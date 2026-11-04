#!/bin/bash
# Turns a fresh Ubuntu 24.04 machine into a desktop: the GNOME "Ubuntu" session on Xvnc, noVNC on
# port 6901, Google Chrome, developer and automation tools, and Node.js for recipe steps. Every desktop
# gets this; a recipe's own setup.sh runs after it. Runs as root, and can run again.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
install -d /etc/blobby
step() { echo "blobby-setup: $*"; }
quiet() { "$@" >/tmp/blobby-setup.log 2>&1 || { tail -n 40 /tmp/blobby-setup.log >&2; exit 1; }; }

. /etc/os-release
if [ "$VERSION_ID" != 24.04 ]; then
  echo "blobby-setup: needs Ubuntu 24.04, not $VERSION_ID" >&2
  exit 1
fi

step "Installing GNOME and the VNC server"
quiet apt-get update
quiet apt-get install -y --no-install-recommends \
  gnome-shell gnome-session ubuntu-session ubuntu-settings gnome-shell-extension-ubuntu-dock \
  yaru-theme-gnome-shell yaru-theme-gtk yaru-theme-icon gnome-terminal nautilus gnome-control-center \
  gjs librsvg2-common dbus-x11 dconf-cli at-spi2-core python3-pyatspi \
  fonts-ubuntu fonts-dejavu-core fonts-noto-cjk fonts-noto-color-emoji \
  tigervnc-standalone-server tigervnc-tools websockify sudo ca-certificates curl gpg

step "Installing Google Chrome"
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /usr/share/keyrings/google-chrome.gpg
if [ ! -e /etc/apt/sources.list.d/google-chrome.list ]; then
  cat >/etc/apt/sources.list.d/google-chrome.sources <<'EOF'
Types: deb
URIs: https://dl.google.com/linux/chrome/deb/
Suites: stable
Components: main
Signed-By: /usr/share/keyrings/google-chrome.gpg
EOF
fi
quiet apt-get update
quiet apt-get install -y --no-install-recommends google-chrome-stable
# Chrome's package adds its own repository entry.
if [ -e /etc/apt/sources.list.d/google-chrome.list ]; then rm -f /etc/apt/sources.list.d/google-chrome.sources; fi

step "Installing developer and automation tools"
quiet apt-get install -y --no-install-recommends \
  git openssh-client less build-essential pkg-config python3-pip python3-venv python-is-python3 \
  unzip zip xz-utils wget jq ripgrep file nano vim-tiny procps lsof iproute2 iputils-ping \
  bubblewrap socat slirp4netns iptables xdotool wmctrl scrot ffmpeg \
  mesa-vulkan-drivers libvulkan1 vulkan-tools

step "Installing the noVNC viewer"
# Only noVNC's web files: its package's dependencies are for running it as a service.
rm -rf /tmp/novnc && mkdir -p /tmp/novnc && (cd /tmp/novnc && quiet apt-get download novnc)
dpkg-deb -x /tmp/novnc/novnc_*.deb /tmp/novnc/root
rm -rf /usr/share/novnc && cp -rL /tmp/novnc/root/usr/share/novnc /usr/share/novnc
rm -rf /tmp/novnc /var/lib/apt/lists/*

step "Installing Node.js for recipe steps"
# Recipe steps, such as signing in, run on Node.js with playwright-core, which blobby-sandbox copies in from its own install.
node_version=22.23.4
case "$(dpkg --print-architecture)" in
  amd64) node_arch=x64; node_sum=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406 ;;
  arm64) node_arch=arm64; node_sum=f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9 ;;
  *) echo "blobby-setup: recipe steps need an amd64 or arm64 machine" >&2; exit 1 ;;
esac
curl -fsSLo /tmp/node.tar.gz "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$node_arch.tar.gz"
echo "$node_sum  /tmp/node.tar.gz" | sha256sum -c - >/dev/null
rm -rf /opt/blobby/node && mkdir -p /opt/blobby/node
tar -xzf /tmp/node.tar.gz -C /opt/blobby/node --strip-components=1 --no-same-owner \
  --exclude='*/include' --exclude='*/share' --exclude='*/lib/node_modules' --exclude='*/bin/npm' --exclude='*/bin/npx' --exclude='*/bin/corepack'
rm /tmp/node.tar.gz

step "Configuring the desktop"
id -u ubuntu >/dev/null 2>&1 || useradd --create-home --uid 1000 --user-group --shell /bin/bash ubuntu
getent group render >/dev/null || groupadd --system render
usermod -aG sudo,video,render ubuntu
echo 'ubuntu ALL=(ALL:ALL) NOPASSWD: ALL' >/etc/sudoers.d/blobby && chmod 0440 /etc/sudoers.d/blobby

# GNOME needs a system bus even without systemd or logind. This one runs as the desktop user and
# starts no services, so calls to logind or UPower fail at once.
cat >/etc/blobby/system-bus.conf <<'EOF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>system</type>
  <listen>unix:path=/run/user/1000/system_bus_socket</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF

# No lock screen, blanking, or animations. Apps publish their accessibility trees, so agents can read the UI.
install -d /etc/dconf/profile /etc/dconf/db/local.d
printf 'user-db:user\nsystem-db:local\n' >/etc/dconf/profile/user
cat >/etc/dconf/db/local.d/00-blobby <<'EOF'
[org/gnome/desktop/screensaver]
lock-enabled=false
idle-activation-enabled=false
ubuntu-lock-on-suspend=false

[org/gnome/desktop/lockdown]
disable-lock-screen=true

[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/settings-daemon/plugins/power]
idle-dim=false
sleep-inactive-ac-type='nothing'
power-button-action='nothing'

[org/gnome/desktop/interface]
enable-animations=false
toolkit-accessibility=true

[org/gnome/shell]
favorite-apps=['google-chrome.desktop', 'org.gnome.Nautilus.desktop', 'org.gnome.Terminal.desktop']
welcome-dialog-last-shown-version='4294967295'
EOF
dconf update
# USB protection needs USBGuard on the system bus and crashes without it.
install -d /etc/xdg/xdg-ubuntu/autostart
printf '[Desktop Entry]\nType=Application\nName=USB Protection\nHidden=true\n' \
  >/etc/xdg/xdg-ubuntu/autostart/org.gnome.SettingsDaemon.UsbProtection.desktop

# Chrome opens links. Without an unlocked keyring, apps keep secrets in their own store.
cat >/etc/xdg/mimeapps.list <<'EOF'
[Default Applications]
x-scheme-handler/http=google-chrome.desktop
x-scheme-handler/https=google-chrome.desktop
text/html=google-chrome.desktop
EOF
# Chrome publishes web pages' accessibility trees only with --force-renderer-accessibility. It doesn't change how pages look.
# boot.sh writes no-chromium-sandbox on machines that can't run Chromium's sandbox, such as Docker containers.
cat >/usr/local/bin/google-chrome-stable <<'EOF'
#!/bin/sh
if [ -e /etc/blobby/no-chromium-sandbox ]; then set -- --no-sandbox "$@"; fi
exec /usr/bin/google-chrome-stable --no-first-run --no-default-browser-check --password-store=basic --force-renderer-accessibility "$@"
EOF
chmod 0755 /usr/local/bin/google-chrome-stable
ln -sf google-chrome-stable /usr/local/bin/google-chrome
install -d /usr/local/share/applications
sed 's#^Exec=/usr/bin/google-chrome-stable#Exec=/usr/local/bin/google-chrome-stable#' \
  /usr/share/applications/google-chrome.desktop >/usr/local/share/applications/google-chrome.desktop
runuser -u ubuntu -- sh -c 'mkdir -p ~/.local/share/gnome-shell && touch ~/.local/share/gnome-shell/lock-warning-shown'
step "Installed the desktop"
