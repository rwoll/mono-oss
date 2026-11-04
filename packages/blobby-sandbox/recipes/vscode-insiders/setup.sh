#!/bin/bash
# Installs VS Code Insiders on top of the base desktop. Runs as root after the runtime's setup.sh,
# once per base. Lines that start with `blobby-setup: ` are progress.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
step() { echo "blobby-setup: $*"; }
quiet() { "$@" >/tmp/blobby-setup.log 2>&1 || { tail -n 40 /tmp/blobby-setup.log >&2; exit 1; }; }

step "Installing VS Code Insiders"
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /usr/share/keyrings/microsoft.gpg
# boot.sh updates Insiders from this repository alone, with its own package lists.
install -d /etc/blobby/code-insiders-sources /var/lib/blobby/code-insiders-lists/partial
cat >/etc/blobby/code-insiders-sources/vscode.sources <<'EOF'
Types: deb
URIs: https://packages.microsoft.com/repos/code
Suites: stable
Components: main
Signed-By: /usr/share/keyrings/microsoft.gpg
EOF
cp /etc/blobby/code-insiders-sources/vscode.sources /etc/apt/sources.list.d/vscode.sources
echo "code-insiders code-insiders/add-microsoft-repo boolean false" | debconf-set-selections
quiet apt-get update
quiet apt-get install -y --no-install-recommends code-insiders
rm -rf /var/lib/apt/lists/*

# Insiders is in the dock and opens text files. These files come after the runtime's, so they win.
cat >/etc/dconf/db/local.d/10-vscode-insiders <<'EOF'
[org/gnome/shell]
favorite-apps=['google-chrome.desktop', 'com.microsoft.VSCodeInsiders.desktop', 'org.gnome.Nautilus.desktop', 'org.gnome.Terminal.desktop']
EOF
dconf update
grep -q '^text/plain=' /etc/xdg/mimeapps.list || echo 'text/plain=com.microsoft.VSCodeInsiders.desktop' >>/etc/xdg/mimeapps.list

# Every launch goes through this wrapper, first on the PATH and in the desktop entries, which adds
# --no-sandbox on machines that can't run Chromium's sandbox, such as Docker containers (see the
# runtime's boot.sh). The package's own entries stay as they are, so updates don't undo this.
cat >/usr/local/bin/code-insiders <<'EOF'
#!/bin/sh
if [ -e /etc/blobby/no-chromium-sandbox ]; then set -- --no-sandbox "$@"; fi
exec /usr/share/code-insiders/bin/code-insiders "$@"
EOF
chmod 0755 /usr/local/bin/code-insiders
install -d /usr/local/share/applications
for entry in /usr/share/applications/com.microsoft.VSCodeInsiders*.desktop; do
  sed 's#^Exec=/usr/share/code-insiders/code-insiders#Exec=/usr/local/bin/code-insiders#' "$entry" >"/usr/local/share/applications/$(basename "$entry")"
done

# VS Code keeps secrets in its own store, as there is no unlocked keyring. It builds its accessibility
# tree from the start, for agents; with accessibility support off, it doesn't take the tree for a
# screen reader and stays in its normal mode instead of switching to Screen Reader Optimized.
runuser -u ubuntu -- sh -c 'mkdir -p ~/.vscode-insiders "$HOME/.config/Code - Insiders/User" \
  && printf "{\n  \"password-store\": \"basic\",\n  \"force-renderer-accessibility\": true\n}\n" > ~/.vscode-insiders/argv.json \
  && settings="$HOME/.config/Code - Insiders/User/settings.json" \
  && { [ -e "$settings" ] || printf "{\n  \"editor.accessibilitySupport\": \"off\"\n}\n" > "$settings"; }'
step "Installed VS Code Insiders"
