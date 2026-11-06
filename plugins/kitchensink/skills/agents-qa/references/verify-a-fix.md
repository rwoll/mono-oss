# Verify a fix in a sandbox

Fixes to the Agents window are verified **live**: build Code OSS from your branch inside a desktop sandbox signed in to the GitHub test account, walk the original repro steps, and capture real **after** screenshots. Stubs, fixtures, and macOS builds are not enough.

## 1. Get a sandbox

Start your own sandbox with `blobby-sandbox` rather than sharing one, named after the finding's key (up to 24 characters of lowercase letters, digits, and dashes, for example `fix-merge-silent`):

```sh
SB=fix-merge-silent
blobby-sandbox doctor --json
blobby-sandbox start $SB --recipe vscode-insiders --resolution 1600x1000 --json
blobby-sandbox exec $SB --secret github --json -- vscode-signin
```

`vscode-signin` signs VS Code Insiders in to the test account, which the user entered once with `blobby-sandbox secrets set github`. If `doctor` says that secret is missing, stop and ask the user to set it; never handle it yourself. Run commands in the sandbox from this machine with:

```sh
blobby-sandbox exec $SB -- bash -lc '<command>'           # as the desktop user, in the desktop session
blobby-sandbox exec $SB --root -- sh -c '<command>'       # as root, for system changes
```

The sandbox has git, curl, Python, and common developer tools. Install the rest of VS Code's build dependencies as root, retrying if the mirror hiccups: `apt-get update && apt-get install -y build-essential pkg-config libx11-dev libx11-xcb-dev libxkbfile-dev libsecret-1-dev libkrb5-dev`.

Take screenshots, and drive the UI, with:

```sh
blobby-sandbox screenshot $SB -o <path on this machine>.png --json
blobby-sandbox input $SB click 640 400
blobby-sandbox ui $SB --match "<text>" --json
```

## 2. Reproduce first

Reproduce the bug on Insiders in this sandbox, following the finding's repro steps, before you change anything. If it doesn't reproduce, stop and report that.

## 3. Build your branch

Push your branch first. Then, in the sandbox:

```sh
# Node from the branch's .nvmrc, for this machine's architecture
V=$(curl -fsSL https://raw.githubusercontent.com/microsoft/vscode/<branch>/.nvmrc)
A=$(dpkg --print-architecture | sed 's/amd64/x64/')
curl -fsSL https://nodejs.org/dist/v$V/node-v$V-linux-$A.tar.xz -o /tmp/node.tar.xz
mkdir -p ~/.node && tar -xJf /tmp/node.tar.xz -C ~/.node --strip-components=1
echo 'export PATH=$HOME/.node/bin:$PATH' >> ~/.bashrc

# The repository, with your branch
git clone --filter=blob:none https://github.com/microsoft/vscode ~/vscode
cd ~/vscode && git fetch -q origin <branch> && git checkout -q FETCH_HEAD

# Install and build. npm ci can fail transiently, so retry it.
for i in 1 2 3; do timeout 1500 npm ci && break; done
npm run build-fast            # the client and built-in extensions, including Copilot
node build/lib/preLaunch.ts   # Electron and built-in extensions
```

Run the long steps in the background with output to a log file (for example `> ~/build.log 2>&1 &`) and check the log, rather than holding a command open for half an hour. After you push more changes, fetch, check out, and rerun `npm run build-fast`. It's incremental.

## 4. Launch it and verify

```sh
cd ~/vscode && (setsid env VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh --no-sandbox --password-store=basic \
  --user-data-dir ~/oss/data --extensions-dir ~/oss/ext > ~/oss.log 2>&1 &)
```

- **Sign in.** In Code OSS, sign in with GitHub, then click **Authorize** or **Continue** in the sandbox's Chrome. If Chrome is already signed in to github.com there, that's all it takes. If it would need the account's password or a 2FA code, don't enter them: verify what you can signed out, and say so. Never read, print, or store tokens.
- **Verify.** Open the Agents window and walk the repro steps. Record an **after** video of the same repro when the finding has a **before** video, and capture an **after** screenshot for each **before** screenshot, in the same order and framing.
- **Retest after fixes.** If the live run shows a problem, fix it, push, rebuild, and test again.
- **Clean up.** Quit Code OSS, then remove your sandbox when you're done (`blobby-sandbox rm $SB --json`).

## 5. Put it in the pull request

- Upload the media with the `gh` CLI to `https://uploads.github.com/user-attachments/assets`, using `gh auth token`. Lead with the before and after videos, annotated, or with a before/after screenshot table when one frame shows the change.
- Add one line: "Validated live on Ubuntu 24.04 <architecture> with Code OSS built from `<commit>`."
- List anything you couldn't verify.
