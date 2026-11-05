---
name: blobby-sandbox
description: "Start, drive, and record disposable sandboxes with an Ubuntu desktop using the `blobby-sandbox` CLI, by default with VS Code Insiders, which a built-in script signs in to a GitHub test account on request. Use when asked to reproduce, test, try out, or demo something in VS Code Insiders, Chrome, or another Linux app on a clean desktop, to drive an app through its UI for computer-use testing, or to capture screenshots or recordings as evidence."
---

# Blobby Sandbox

`blobby-sandbox` runs disposable sandboxes made from a recipe. Each one has an Ubuntu GNOME desktop with Google Chrome and developer tools. The default recipe, `vscode-insiders`, adds VS Code Insiders; `desktop` is just the desktop. Nothing is signed in until you run a sign-in script with `exec --secret`. Sandboxes run on a **backend** that `blobby-sandbox doctor` picks for this computer (Azure when the user has set it up in `~/.config/blobby/azure.json`, else smolvm on macOS on Apple silicon or Linux with KVM, else Docker), or on a server when `BLOBBY_SANDBOX_SERVER` is set. The commands are the same everywhere. Every command takes `--json`; use it, and read `error.code` and `error.message` when a command fails.

Use `blobby-sandbox` from PATH. If it isn't installed, ask the user, then run `node scripts/install-tools.ts blobby-sandbox` from this skill's folder. It installs `@rwoll/blobby-sandbox` globally from its newest GitHub release, after checking the download against GitHub's digest; its other dependencies come from npm's registry, only once they're 7 days old. Add `--azure` when the user wants the azure backend and `doctor` reports `azure_sdk_missing`. If it fails, show the user its message, and stop. Don't run the CLI with npx.

## Rules

- **Never handle secrets.** Only the user runs `blobby-sandbox secrets set`, in their own terminal. If `blobby-sandbox doctor` says a secret is missing, or reports an allowlist problem (`login_not_allowed`), show the user its message, and stop. Never read the secrets' files or run their providers yourself, and never edit `~/.config/blobby/config.json` or set `BLOBBY_SANDBOX_ALLOWED_LOGINS`: only the user decides which accounts' secrets go into sandboxes. Give a command a secret only with `exec --secret`, never through `--env`, `--stdin`, files, or arguments.
- **Test accounts are compromised by design.** Each person uses a dedicated GitHub test account (one per person), never their own. Anything in a sandbox can use its sessions. Never sign in to anything else in a sandbox, and never put the user's own tokens, keys, or files in one.
- **Work in the sandbox, never on the host.** Run apps, builds, and repro steps in the sandbox, not on the user's machine.
- **Leave the backend to `doctor`.** Pass `--backend <name>` only when the user asks for one. If the backend isn't usable (`backend_unavailable`, `smolvm_missing`, or a failed check), show the user the message, which says what to do, and stop.
- **Clean up.** Remove sandboxes you created when the task is done (`blobby-sandbox rm <name>`), unless the user wants to look at them.

## Your test account

Sandboxes sign in only to a dedicated GitHub test account of the user's, never their personal account. The user sets it up once, themselves:

- **The allowlist.** Its login goes in `allowedLogins` in `~/.config/blobby/config.json` (or `BLOBBY_SANDBOX_ALLOWED_LOGINS`). Every secret's login must be on it: with an empty list, or a login not on it, `exec --secret` is refused before anything runs, with `login_not_allowed`.
- **The secret, by path.** `blobby-sandbox secrets set github --file <path>` points at the account file they already keep; only the path is saved. `secrets set github` (keyboard) and `--provider` also work.
- **Nothing else.** Sandboxes never get the host's environment, tokens, SSH agent, or files; credentials passed to `exec` fail with `env_blocked`. Don't try to pass them.

`doctor` shows where each secret comes from and whether it works, never logins or values. Never write a test account's login in reports, issues, pull requests, or commits.

## Start a sandbox

```sh
blobby-sandbox doctor --json                                  # the backend, why, whether it works, the secrets, and the allowlist
blobby-sandbox start repro-123 --resolution 1600x1000 --json  # VS Code Insiders, not signed in yet
blobby-sandbox exec repro-123 --secret github --json -- vscode-signin   # signs VS Code in, then opens it
blobby-sandbox view repro-123                                 # show its desktop to the user in their browser
```

Azure sandboxes have no live viewer yet: `view` fails with `unsupported`, so show the user screenshots instead.

In `doctor --json`, `backend` says which backend runs sandboxes (`name`), why (`reason`), and whether it works (`ok`, and `detail` when it doesn't). The first sandbox of a recipe installs a base, which takes a few minutes; later ones start from it in seconds. Name sandboxes after the task, with lowercase letters, digits, and dashes. `--recipe desktop` gives just the desktop. `--cpus`, `--memory`, and `--no-gpu` install the sandbox from scratch, so use them only when the task needs them.

Sign in only when the task needs it: `vscode-signin` takes about 20 seconds, quits VS Code first, and opens it again signed in. Its JSON `result` says `{ "github": { "signedIn": true, "verified": true } }` when it worked; on a failure, read the end of its `stdout` and run it once more before reporting it. It's safe to run again. The values it gets, the login too, show as `***`.

## Scripts

Every sandbox has scripts on the `PATH` of `exec`, for things that would otherwise take trial and error. List them, and read a script's `--help` before you use it:

```sh
blobby-sandbox exec repro-123 -- blobby-scripts
blobby-sandbox exec repro-123 -- vscode-signin --help
```

Only scripts run with `--secret` can ask for the secret, and only its fields. To run something of your own, write it, copy it in with `blobby-sandbox cp`, and run it with `exec`.

## Open apps

To open VS Code Insiders again, optionally with a folder or file in the sandbox, or Chrome:

```sh
blobby-sandbox exec repro-123 -- vscode-open '~/repo'      # quote ~ for the sandbox; returns once a window shows
blobby-sandbox exec repro-123 --root -- vscode-update      # the newest Insiders build; start does this too
blobby-sandbox exec repro-123 -- sh -c 'setsid google-chrome https://github.com >/dev/null 2>&1 &'
```

`blobby-sandbox exec` runs as the desktop user in the desktop session, so windows, `xdotool`, and `wmctrl` work. Add `--root` for system changes, such as `blobby-sandbox exec repro-123 --root -- apt-get install -y <package>`; apt doesn't prompt as root. The desktop user can also use `sudo`.

## Drive it: choose a mode

Pick the mode for the task, and say which one you are using.

- **Efficient: the accessibility tree.** For directed work: following known repro steps, verifying a fix, or getting somewhere fast. `blobby-sandbox ui` lists visible, named elements with a path and a screen box; `blobby-sandbox ui <name> <path>` presses one, and `focus` or `set TEXT` after the path focus it or replace its text. See [references/accessibility.md](references/accessibility.md).
- **Visual: screenshots.** For exploring and QA, where the point is to notice what looks wrong: misaligned or clipped UI, wrong colors or icons, flicker, confusing states. Take a screenshot after every action, look at it before deciding the next step, and act with `blobby-sandbox input` at what you see. The pointer moves as a hand moves a mouse, so hover effects show and recordings look natural. See [references/visual.md](references/visual.md).

The two mix: explore visually, and drop to the tree to find an element you can't place. Never conclude from the tree alone that something looks right; only a screenshot shows that.

Don't record or screenshot while `vscode-signin` runs: wait for it to finish.

## Capture evidence

```sh
blobby-sandbox screenshot repro-123 --out evidence/01-before.png --json
blobby-sandbox record repro-123 start --max-seconds 300
# ... reproduce ...
blobby-sandbox record repro-123 stop --out evidence/repro.mp4 --json
```

Show what you claim: a screenshot right after the step that shows it, and the same framing for before and after. Look at every image before you share it. Never capture a password or 2FA entry. See [references/evidence.md](references/evidence.md) for pull requests and issues.

## Clean up

```sh
blobby-sandbox list --json
blobby-sandbox stop repro-123      # keeps its files; start brings it back in seconds
blobby-sandbox rm repro-123        # deletes it
```
