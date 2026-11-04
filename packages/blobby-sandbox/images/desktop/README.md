# Desktop image

`blobby-desktop` is the one image that desktop sandboxes run: Ubuntu 24.04 with GNOME 46's "Ubuntu"
session on TigerVNC, a browser viewer (noVNC), VS Code's command sandbox, developer tools, screen
capture, accessibility, and Node.js with playwright-core for recipe steps. The Docker backend runs it
as a container.

It holds **redistributable software only**. Google Chrome and VS Code Insiders aren't in
it: they're installed when a sandbox is set up (see
[Installing Chrome and VS Code](#installing-chrome-and-vs-code)).

From the package folder, `packages/blobby-sandbox`:

```sh
node images/desktop/build.ts        # build blobby-desktop:<hash> and :latest for this machine
node images/desktop/smoke.ts        # start it with plain Docker and check the desktop works
```

## What's in it

Everything comes from Ubuntu's signed archive, except Node.js and playwright-core, which are pinned and
checked against their checksums. The [Dockerfile](Dockerfile) lists every package.

| Part | Why |
|---|---|
| `ubuntu:24.04`, pinned by digest | GNOME 46 is the newest GNOME with an X11 session, which Xvnc needs |
| The stock Ubuntu GNOME session, without gdm3, Snap, or systemd | Agents and people see the desktop they expect |
| TigerVNC, websockify, and noVNC on port **6901** | The X server and the browser viewer |
| AT-SPI with `toolkit-accessibility=true`, `xdotool`, `wmctrl`, `scrot`, and ffmpeg | `ui`, input, screenshots, and MP4 recordings |
| bubblewrap, `socat`, `slirp4netns`, `iptables` | VS Code's and Copilot's [command sandbox](#command-sandbox) |
| git, build tools, Python, `jq`, `ripgrep`, `curl`, `gpg`, and the like | A sandbox works like a developer's machine |
| Node.js 22.23.4 and playwright-core 1.58.2 in `/opt/blobby` | Recipe steps and scripts such as `vscode-signin`; the same versions and paths the engine uses, so it copies nothing |
| User `ubuntu` (uid 1000) with passwordless sudo | Runs the session and apps; `no-new-privileges` stops sudo where root isn't allowed |
| Session config, Chrome and VS Code launchers, and `/etc/blobby/image` | The same files `runtime/setup.sh` writes on other backends (a test keeps them equal); the marker says what the image provides |
| `/opt/blobby/image/` | Scripts that [install Chrome and VS Code](#installing-chrome-and-vs-code) |

The build ends with `/opt/blobby/image/bin/check`, which fails if anything above is missing, or if
Chrome, VS Code Insiders, or their apt sources are in the image.

### Not in it

- **Google Chrome and VS Code Insiders**, which come from the vendors' signed repositories when a
  sandbox is set up.
- **The guest runtime** (the package's `runtime/`). blobby-sandbox copies its own runtime into
  `/opt/blobby/runtime` every time it starts a sandbox, so the runtime always matches the library
  that drives it. The image has every package the runtime needs, so on Docker nothing has to be
  installed before the session starts.
- **systemd, logind, or a display manager.** `runtime/boot.sh` and `session.sh` start the session.
- **A viewer password.** `boot.sh` makes one for each sandbox the first time it starts.

## Build

```sh
node images/desktop/build.ts [--json] [--platform linux/amd64|linux/arm64] [--no-cache] [--pull]
  [--builder <name>] [--cache-from <spec>]... [--cache-to <spec>]... [--verbose] [--dry-run] [--hash]
```

It needs Docker with BuildKit (Docker Engine 23 or later, or Docker Desktop) and no npm packages.

- **Tags:** `blobby-desktop:<hash>` and `blobby-desktop:latest`, where `<hash>` is the first 12 hex
  digits of a SHA-256 over every file in this folder: its path, executable bit, and contents. A change
  to any file here makes a new tag; unchanged steps still come from Docker's cache. `--hash` prints the
  hash without building.
- **Platform:** the Docker host's architecture by default, so it runs natively on Apple silicon.
  `--platform` builds another one (amd64 or arm64) with emulation, tagged `blobby-desktop:<hash>-<arch>`
  only, so it never replaces the image this machine runs.
- **Labels:** `blobby.dev/image=desktop`, and `org.opencontainers.image.title`, `.source`
  (`https://github.com/rwoll/mono-oss`), `.licenses` (`MIT`), `.version` (the hash), `.revision` (the
  git commit, when there is one), `.base.name`, and `.base.digest`.
- **npm registry:** playwright-core comes from `pnpm_config_registry` or `npm_config_registry` when set,
  otherwise from the `registry=` line of the repository's `.npmrc`, otherwise from the public registry.
  Only that line is read. The Dockerfile never names a registry: the build gets it as a BuildKit secret,
  so the host stays out of the image's history, and the pinned SHA-512 decides what's installed.
- **Caches and builders:** `--builder`, `--cache-from`, and `--cache-to` switch to `docker buildx build
  --load`, for example to export the layer cache in CI. Everything else works with plain `docker build`.
- **Output:** progress goes to stderr, one line per Dockerfile step. The result goes to stdout; with
  `--json`:

  ```json
  { "image": "blobby-desktop:1b6483b80911", "tags": ["blobby-desktop:1b6483b80911", "blobby-desktop:latest"],
    "hash": "1b6483b80911", "digest": "<sha256 of the files>", "platform": "linux/arm64",
    "id": "sha256:…", "size": "3.05GB", "seconds": 86.4 }
  ```

  `size` is what `docker images` shows. Errors go to stderr as `{ "error": { "code", "message" } }`, with
  exit code 1. Codes: `docker_unavailable`, `image_build_failed`, `unsupported_platform`,
  `invalid_image_files`, `cancelled`, and `usage`.

From code, `buildDesktopImage(options)` resolves with the same object and throws `ImageError`.

### Multiple architectures

The image builds for amd64 and arm64: every package is in Ubuntu's archive for both, and Node.js has a
pinned checksum for each. Build each natively (CI builds amd64 on an amd64 runner), or one on the other
with `--platform` and QEMU, which is much slower.

### Sizes and timings

| | Apple silicon, Docker Desktop | GitHub's `ubuntu-latest` |
|---|---|---|
| Image size | 3.05 GB (compressed and unpacked layers) | 2.06 GB |
| Cold build | 1.5 to 2.5 min | 3.3 min; about 1.5 min from the layer cache |
| `docker run` to GNOME Shell up | about 2 s | 3 to 4 s |
| Idle desktop memory | about 410 MiB | |

## Smoke test

```sh
node images/desktop/smoke.ts [--image blobby-desktop:latest] [--resolution 1280x800] [--only <checks>]
  [--artifacts <dir>] [--without-entrypoint] [--apparmor-unconfined] [--keep] [--json]
```

It doesn't use the Docker backend: it runs `docker run` with argument arrays the way the backend runs a
sandbox with the command sandbox, never privileged and with no added capabilities, with the
command-sandbox seccomp profile, `--device /dev/net/tun`, `no-new-privileges`, and the viewer published
on `127.0.0.1` only. It copies the package's `runtime/` into `/opt/blobby/runtime`, runs
`boot.sh 1280x800` as root, and then checks, through the runtime's own `guest.py` operations:

| Check | Proves |
|---|---|
| `image` | `/opt/blobby/image/bin/check` passes: everything the runtime needs, and no proprietary apps |
| `session` | `boot.sh` starts the session, and GNOME Shell comes up (`guest.py status`) |
| `screenshot` | A screenshot is a PNG of the whole screen, and the screen is painted, not one flat color |
| `accessibility` | The AT-SPI tree lists GNOME Shell's elements |
| `viewer` | `GET /vnc.html` answers 200, and the WebSocket reaches the VNC server (`RFB 003.008`) |
| `command-sandbox` | `bwrap --unshare-net --dev-bind / / echo ok` prints `ok` |
| `recording` | A 5-second recording reads back intact (size and SHA-256) and is an H.264 MP4 |

It removes the container and its temporary seccomp file afterwards, also when a check fails, unless
`--keep` is set. `--without-entrypoint` starts the container with `sleep infinity` instead of the image's
entry point, to show the image works where nothing runs it. Each check is an entry in `CHECKS` in
`smoke.ts`, so the guest-operation tests can add more (`smokeTest(options)` is exported too).

`build.test.ts` runs with the package's tests (`pnpm test`). It checks the content hash, the build
command, the registry rule, and that the pins agree with their sources: Node.js with the runtime's
`setup.sh`, playwright-core with the package's `package.json` and `pnpm-lock.yaml`, the session files
with `setup.sh`, and the seccomp profile with its pinned SHA-256.

## Entry point

The image must work both as a container, where a runtime starts its entry point as PID 1, and as a
machine that boots it and runs commands in it (Azure sandboxes), where nothing runs the entry point.
So the entry point does nothing that matters:

- `ENTRYPOINT ["/usr/bin/tini", "-g", "--"]`: under Docker, tini is PID 1. It forwards signals and
  reaps the session's orphaned processes.
- `CMD ["/usr/local/bin/blobby-desktop", "idle"]`: waits until it's stopped, and exits at once on
  SIGTERM, so `docker stop` is immediate. `blobby-desktop session [WxH]` starts the session with a
  runtime that's already in `/opt/blobby/runtime`, then waits; `blobby-desktop check` runs the check.
- The default user is root and the working folder `/`, as on a booted machine.

The contract with blobby-sandbox (any backend):

1. Start the machine. Commands run as root unless they name a user.
2. Copy the runtime into `/opt/blobby/runtime` and make it readable (`chmod -R a+rX /opt/blobby`).
3. Run `bash /opt/blobby/runtime/boot.sh <WxH>` as root. It prints `blobby-boot: started` (or `running`),
   makes the viewer password, and starts `session.sh` as `ubuntu` in its own session. Everything the
   session needs at run time (`/run/user/1000`, the X11 socket folders, `/dev/shm`) `boot.sh` creates,
   so nothing depends on the entry point having run.
4. Run guest operations as `ubuntu` with the variables in `runtime/session.env`.
5. The viewer is on guest port 6901. Docker publishes it when the container is created; stopping and
   starting a container keeps the image's state, and `session.sh` clears stale X locks and sockets.

On this image, `runtime/setup.sh` only rewrites the same session files, and installs Chrome and its
launcher.

## Installing Chrome and VS Code

Today the runtime's `setup.sh` and the `vscode-insiders` recipe install both apps. The image also keeps
inactive apt sources and scripts in `/opt/blobby/image` for recipes that install them on this image:

- **`bin/install-app <vscode-insiders|google-chrome>`** (root, idempotent, 10 to 30 s) fetches the
  vendor's signing key and refuses it unless its primary key's fingerprint is the pinned one, enables
  the vendor's repository, and installs the app. Its `.desktop` files go to
  `/usr/local/share/applications`, so the dock starts the app through the `--no-sandbox` launcher. It
  prints `blobby-setup:` progress and, last, `blobby-info: <app> <version>`.
- **`bin/update-code-insiders`** (root; run it before anything opens VS Code) reads only Microsoft's
  repository, so it takes about a second when Insiders is current, and leaves a running VS Code alone.
  It ends with `blobby-update: <updated|current|skipped> <before> <after>`. The launchers wait for it.
- **`bin/after-code-update <command>`** runs a command once any update has finished, and **`bin/check`**
  is the image's self-check.

## Command sandbox

VS Code's terminal sandbox and Copilot's sandbox run commands with bubblewrap, which needs unprivileged
user, mount, and network namespaces, and `/dev/net/tun` for slirp4netns. Docker's default seccomp
profile allows the namespace syscalls only to containers with `CAP_SYS_ADMIN`, which sandboxes never
get, so bubblewrap fails with "No permissions to create new namespace".

`seccomp/docker-default.json` is an unchanged copy of Docker's own default profile, from
[moby/profiles](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json)
(Apache-2.0, `seccomp/LICENSE`). `seccomp/command-sandbox.ts` derives the command-sandbox profile from
it: Docker's rules with only the namespace syscalls (`clone`, `clone3`, `unshare`, `setns`, the mount
syscalls, `pivot_root`, `sethostname`, and `setdomainname`) allowed. Pinning a copy, instead of using
whatever profile the host's Docker has, keeps every other rule Docker's and makes the difference
reviewable. A process gets capabilities only inside namespaces it creates; in the container itself,
root still lacks `CAP_SYS_ADMIN`, so it still can't mount anything.

The Docker backend applies that profile and `--device /dev/net/tun` **only** for sandboxes created
with `commandSandbox: true`. Others keep Docker's default profile. The trade-off: user namespaces expose
more of the kernel to code in the sandbox, which is why Docker blocks them by default.

Chrome and VS Code Insiders run with `--no-sandbox` in every sandbox, so they start the same way with or
without the command sandbox: Chromium's own sandbox needs the same namespaces. The sandbox itself is
the boundary.

Linux hosts with AppArmor, such as Ubuntu, need two more opt-ins; see
[The docker backend](../../docs/reference.md#the-docker-backend). CI makes both on its throwaway runner.

## CI

`.github/workflows/blobby-desktop-image.yml` builds the image on an amd64 runner and runs the smoke test,
with and without the entry point. It runs for pushes to `main` that change the image or the runtime, and
by hand (**Run workflow**). It has a read-only token, no secrets, and 30 minutes. It
keeps BuildKit's layer cache in the Actions cache, with BuildKit pinned by digest, and replaces it after
each build so it doesn't grow.

## Updating pins

- **Ubuntu:** `docker buildx imagetools inspect ubuntu:24.04` shows the index digest. Change it in
  `FROM` and the `base.digest` label together.
- **Node.js:** change `node_version` and its two checksums in `runtime/setup.sh` and the
  `NODE_*` arguments here together, from nodejs.org's `SHASUMS256.txt`.
- **playwright-core:** change the dependency in the package's `package.json` (the cooldown applies),
  then `PLAYWRIGHT_CORE_VERSION` and `PLAYWRIGHT_CORE_SHA512` here; the SHA-512 is the hex of the
  lockfile's `integrity`.
- **Vendor keys:** if a vendor replaces its primary key, check the new fingerprint against its install
  guide before changing `install-app`.

The tests fail when these drift apart.

## Licenses

- This folder: MIT, like the repository.
- `seccomp/docker-default.json`: Apache-2.0, from moby/profiles; the license is in `seccomp/LICENSE`.
- noVNC (in the image, `/usr/share/novnc`): MPL-2.0, from Ubuntu's `novnc` package, with its copyright
  file in `/usr/share/doc/novnc/copyright`.
- Everything else in the image comes from Ubuntu's archive under its packages' own licenses (see
  `/usr/share/doc/*/copyright`), and Node.js (MIT) and playwright-core (Apache-2.0) under theirs.
