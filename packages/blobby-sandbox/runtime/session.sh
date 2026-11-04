#!/bin/bash
# The desktop session: Xvnc on display :1, the session and system buses, GNOME's Ubuntu session, and
# noVNC on port 6901. Runs as the desktop user; stops when any part exits.
set -euo pipefail
set -a && . "$(dirname "$0")/session.env" && set +a
# start.sh runs this in its own process group: when any part exits, stop the rest, so start.sh can start it cleanly again.
trap 'trap - EXIT TERM && kill 0' EXIT TERM
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
find "$XDG_RUNTIME_DIR" -mindepth 1 -delete 2>/dev/null || true

Xvnc :1 -geometry "$1" -depth 24 -rfbport 5901 -localhost -SecurityTypes VncAuth \
  -rfbauth "$HOME/.vnc/passwd" -AlwaysShared -desktop "$(hostname)" &
dbus-daemon --session --nofork --nopidfile --address="$DBUS_SESSION_BUS_ADDRESS" &
dbus-daemon --nofork --nopidfile --config-file=/etc/blobby/system-bus.conf &
for _ in $(seq 100); do
  [ -S /tmp/.X11-unix/X1 ] && [ -S "$XDG_RUNTIME_DIR/bus" ] && [ -S "$XDG_RUNTIME_DIR/system_bus_socket" ] && break
  sleep 0.1
done
# Without a systemd user instance, gnome-session starts the session's components itself.
gnome-session --session=ubuntu &
websockify --web /usr/share/novnc 6901 localhost:5901 &
wait -n
