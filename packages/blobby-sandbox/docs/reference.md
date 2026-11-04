# @rwoll/blobby-sandbox

Disposable sandboxes for agent-driven testing, from recipes, on this computer or a server: the
`blobby-sandbox` CLI, and the TypeScript SDK it wraps. Every sandbox made from the built-in recipes has
a GNOME **desktop** that agents can see and drive. The default recipe, `vscode-insiders`, adds VS Code
Insiders, and `exec <name> --secret github -- vscode-signin` signs it in to a GitHub test account when
you want it signed in.

> **Status:** early development, not published to npm yet.

## ⚠️ Test accounts are compromised

Use a dedicated GitHub test account (one per person), and treat it as compromised from the moment you
set it up:

- **Every sandbox holds live, signed-in sessions.** Anyone or anything that can run commands in the
  sandbox can use them: agents, extensions, and the code you're testing.
- **Screenshots and recordings show them**, their names, and whatever they can see.
- **A secret saved with `blobby-sandbox secrets set` sits in a file on your computer**, readable only by
  your user, but so is everything else you run: scripts, packages you install, and AI agents. A provider
  that reads a password manager keeps it off disk.

So:

- **Never use your own account,** or any account you'd mind losing. `blobby-sandbox secrets set github`
  refuses the account the GitHub CLI is signed in as, and secrets go into sandboxes only for logins you
  list in [`allowedLogins`](#the-allowlist).
- **Give it nothing worth stealing:** no organizations with private code, no secrets, no billing, and no
  admin rights anywhere.
- **Use an authenticator app (TOTP) for its 2FA.** blobby-sandbox makes the codes.
- **Don't share it.** GitHub accepts each 2FA code once and limits how many sessions an account has, so
  each person uses their own test account.
- **If you think it leaked, reset it:** change its password, set up 2FA again, and sign out its
  sessions. Then set the secret again.

What blobby-sandbox does to limit the damage: passwords and 2FA codes reach a sandbox only sealed to a
one-time key made by the command that asked for them, the 2FA key never leaves your computer, and every
value is withheld from what blobby-sandbox shows. It doesn't lock the sandbox while a command signs in:
screenshots, recordings, and other commands keep working, so anything in the sandbox can watch.

## Your test account

Sandboxes get secrets only for a **dedicated test account** of your own, never your personal account, in
any form.

1. **Allow its login, yourself.** List it in `~/.config/blobby/config.json` as
   `{ "allowedLogins": ["<login of a dedicated account, NOT your personal one, with no access to your orgs>"] }`, or in `BLOBBY_SANDBOX_ALLOWED_LOGINS`. With an empty
   list, every secret is refused (`login_not_allowed`), and `exec --secret` is refused before anything
   runs. After a command signs in, blobby-sandbox checks that the account it reports is the secret's,
   and on the list.
2. **Point the secret at its file, by path.** If you already keep the account in a file (JSON with
   `username`, `password`, and `totp_key`), run `blobby-sandbox secrets set github --file <path>`. Only the
   path is saved; the file is read when a command asks for the secret, and never copied. It must be your own regular
   file, mode 600 (no group or other bits), and at most 4 KB. Otherwise, use `secrets set github` (from the
   keyboard) or `--provider` (a program, such as one that reads a password manager).
3. **Nothing else of yours goes in.** Sandboxes never get your environment, tokens (`GH_TOKEN`,
   `GITHUB_TOKEN`, `COPILOT_*`, `AZURE_*`, `NPM_TOKEN`, and similar), SSH agent, git credential helpers,
   folders, or browser and VS Code profiles. Your `gh` stays on your computer.

`doctor` and `secrets` show where each secret comes from and whether it works, never its values or the
account's login. Agents never run `secrets set` or edit the allowlist.

## Requirements

Everything needs Node.js 24 or later. Sandboxes
run on a **backend**, and each backend has its own requirements:

| Backend | Runs on | Needs | Status |
|---|---|---|---|
| **smolvm** | macOS on Apple silicon, or Linux (x64 or arm64, glibc) with a `/dev/kvm` this user can open | The `smolmachines` package (an optional peer dependency, see [Install](#install)). For the GPU on Linux: virglrenderer and a Vulkan driver, for example `apt install virglrenderer0 mesa-vulkan-drivers`; macOS needs nothing extra. | Works end to end |
| **docker** | Docker Desktop, or Docker Engine 20.10 or later on Linux, with at least 8 GB of memory and 20 GB of free disk for Docker | Docker running, and its socket reachable (see [The docker backend](#the-docker-backend)). No Docker CLI. | Passes the conformance suite against real Docker |
| **azure** | Any computer that reaches Azure | An Azure Container Apps sandbox group, the `@azure/containerapps-sandbox` package (an optional peer dependency), and the Azure CLI, signed in (see [The azure backend](#the-azure-backend)) | Passes the conformance suite against real Azure sandboxes; the desktop has no viewer yet |

`blobby-sandbox doctor` says which backend it picked, why, and whether this computer can run it.

### Choosing a backend

The backend is, in order:

1. `--backend <name>` on any command, or `connect({ backend })` in the SDK;
2. `BLOBBY_SANDBOX_BACKEND`;
3. the default for this computer: **smolvm** on macOS on Apple silicon, or on Linux with a usable
   `/dev/kvm`, and **docker** everywhere else.

With `--server`, the server picks its own backend: start it with `blobby-sandbox serve --backend <name>`.

### Timings

Measured with smolvm on Apple silicon:

| What | How long |
|---|---|
| The first sandbox of a recipe, which installs the recipe's base | about 2 minutes, once per recipe and setup version |
| Every later sandbox of that recipe, made from the base | a few seconds |
| Signing VS Code in to the test account, with `vscode-signin` | about 20 seconds |
| Starting a stopped sandbox | a few seconds |

With Docker Desktop on Apple silicon, the desktop recipe's base installs in about 4 minutes, and later
sandboxes, made from its snapshot, and restarts take about 2 seconds.

On Azure (`--backend azure`), the base installs in about 5 minutes, about 75 seconds of which is copying
playwright-core in one file at a time. Later sandboxes start from its snapshot in about 10 seconds, and
`vscode-signin` takes about 30 seconds. A screenshot or `ui` takes about 2 seconds, since every guest
operation is a call to the service.

## Install

Until `@rwoll/blobby-sandbox` is on npm, build the CLI from a checkout of rwoll/mono-oss and put it on
your PATH:

```sh
pnpm install --frozen-lockfile && pnpm --filter @rwoll/blobby-sandbox build
ln -s "$PWD/packages/blobby-sandbox/dist/cli.js" ~/.local/bin/blobby-sandbox   # any folder on your PATH
```

In this repository, `smolmachines` is installed for development. Elsewhere, the smolvm backend needs it
installed next to `@rwoll/blobby-sandbox`, at the version the backend is tested with; Docker-only
installs never download it:

```sh
npm install -g @rwoll/blobby-sandbox smolmachines@1.31.0   # the CLI, once it is published
npm install @rwoll/blobby-sandbox smolmachines@1.31.0      # the SDK, in a project
```

Without it, smolvm commands fail with `smolvm_missing` and these instructions. The azure backend needs
`@azure/containerapps-sandbox@1.0.0-beta.1` the same way, and fails with `azure_sdk_missing` without it.

## Use it

```sh
blobby-sandbox secrets set github --file ~/path/to/test-account.json   # once, yourself; or from the keyboard, without --file
echo '{"allowedLogins": ["<login of a dedicated account, NOT your personal one, with no access to your orgs>"]}' > ~/.config/blobby/config.json   # once, yourself
blobby-sandbox doctor                # checks this computer, your secrets, and the allowlist
blobby-sandbox start t1              # creates sandbox t1 with VS Code Insiders, or starts it again
blobby-sandbox exec t1 --secret github -- vscode-signin   # signs VS Code in to the test account
blobby-sandbox view t1               # opens its desktop in your browser
blobby-sandbox list
blobby-sandbox stop t1               # keeps its files; start brings it back in seconds
blobby-sandbox rm t1                 # deletes it
```

The first sandbox of a recipe installs a base, which takes about two minutes. Every later one is made
from it: it starts in a few seconds, and `vscode-signin` takes about 20 more. `--resolution 1600x1000` sets the
screen size, `--json` gives output that scripts and agents can parse, and `blobby-sandbox --help` lists
everything.

Every new sandbox gets a deletion deadline, 24 hours from its creation unless `--delete-after` says
otherwise (`90m`, `8h`, `7d`, or `never`). `blobby-sandbox list --json` shows it as `deleteAfter`. The
deadline is a label on the sandbox for cleanups; nothing deletes sandboxes by it yet.

## Recipes

A recipe says what a sandbox has. Two are built in:

- **`vscode-insiders`** (the default): VS Code Insiders, updated at every start. Sign it in with
  `exec <name> --secret github -- vscode-signin`.
- **`desktop`**: just the desktop.

Every sandbox runs the GNOME "Ubuntu" session with Google Chrome, developer tools, and the automation
tools agents use, and can use the host GPU through Vulkan. Chrome, VS Code, and GNOME don't use the GPU
yet; they render in software.

Your own recipe is a folder, and `blobby-sandbox start t1 --recipe ./my-recipe` sends it along:

```
my-recipe/
  recipe.json   {"apiVersion": 1, "callbacks": {...}, "steps": [...]}
  setup.sh      optional: runs once, as root, when the recipe's base is installed
  boot.sh       optional: runs as root at every start, before the session
  login.mjs     a step, run as the desktop user after a new sandbox starts
```

Everything in a recipe runs only inside the sandbox, never on your computer, so recipes are safe to
share. See [recipes/vscode-insiders](../recipes/vscode-insiders) for a full one.

## Scripts

Every sandbox has a library of scripts, on the `PATH` of `exec`, for what agents would otherwise work out
by trial and error. `blobby-sandbox exec t1 -- blobby-scripts` lists them, and each takes `--help`:

| Script | Does |
|---|---|
| `vscode-signin` | Signs VS Code Insiders in to a GitHub test account, then opens it. Run it with `--secret`. Safe to run again |
| `vscode-open [paths]` | Opens VS Code Insiders, with folders or files in the sandbox, and waits for its window. Takes `code-insiders` options |
| `vscode-update` | Updates VS Code Insiders to the newest build. Run it with `--root`; `start` does this at every start too |
| `blobby-scripts` | Lists the scripts, with `--json` for programs |

They live in [`runtime/scripts`](../runtime/scripts), in `/opt/blobby/runtime/scripts` in the sandbox. Your
own scripts need no library: copy them in with `cp`, and run them with `exec`.

## Secrets

A command gets a secret only when you run it with `--secret`, and then only the fields it asks for while
it runs:

```sh
blobby-sandbox exec t1 --secret github -- vscode-signin
```

Inside, a script asks through the guest library:

```js
import { secret, secretName, progress, done, run } from '/opt/blobby/runtime/lib/blobby.mjs'
run(async () => {
  const login = await secret('login')
  const password = await secret('password')   // sealed to a key this process made for this request
  const code = await secret('otp')            // a current 2FA code, made on your computer
  progress('Signing in to the test account')  // never print the login: it's redacted anyway
  done({ [secretName()]: login })             // checked against the secret and the allowlist, then hidden
})
```

`login`, `username`, and `email` come in the clear; `password`, `otp` (a current 2FA code made from the
secret's `totpSecret`), and `token` come sealed. `BLOBBY_SECRET` holds the secret's name. The command
runs as the desktop user, without `--root`, `--env`, or `--stdin`, and stops after 30 minutes unless
`--timeout` says otherwise, or as soon as it's cancelled, even while it waits for an answer. Its output
streams back a line at a time, with every value it got replaced by `***`.

Recipe steps can ask too, for callbacks their recipe declares; `github.password` is field `password` of
your `github` secret:

```json
"callbacks": { "github.login": {}, "github.password": { "sensitive": true }, "github.otp": { "sensitive": true } },
"steps": [{ "name": "Sign in", "run": "signin.mjs", "uses": ["github.login", "github.password", "github.otp"] }]
```

A step asks with `request('github.password')` from the same library. Only identifiers go in the clear;
every other value must be declared sensitive, and is sealed.

**The login is never shown.** A command or step reports the account it signed in to as
`done({ github: login })`. The resolver checks it against the secret's account and the allowlist, and the
result shows only `{ github: { signedIn: true, verified: true } }`; `exec` says "signed in to the github
test account (allowlisted)". Every value a command gets, the login included, is redacted from its output,
progress, errors, and results, so agents can't copy it into reports, issues, or pull requests.

Secrets come from:

- **A provider**, a program that prints the secret as a JSON object, such as one that reads your
  password manager: `blobby-sandbox secrets set github --provider -- ~/bin/test-account`. blobby-sandbox
  never saves the secret.
- **An account file you keep**, by path: `blobby-sandbox secrets set github --file <path>`. See
  [Your test account](#your-test-account) for what the file must be.
- **The keyboard**: `blobby-sandbox secrets set github` saves it in a file only you can read.

`--secret` takes any secret's name, such as `github-2` for a second account file.

Secrets and their providers live in `~/.config/blobby/` (mode 700; `$XDG_CONFIG_HOME/blobby` when set).
Locks and the record of installed bases live in `~/.local/state/blobby/`.

### The allowlist

blobby-sandbox sends a secret into a sandbox only when its login is one you list, and refuses every field
of it otherwise, so a personal account never ends up in a sandbox by mistake. This holds for every
secret, not only `github`; a secret without a login, such as a bare token, is refused too, until you add
the login of the account it belongs to. List your test account's login in `~/.config/blobby/config.json`:

```json
{ "allowedLogins": ["<login of a dedicated account, NOT your personal one, with no access to your orgs>"] }
```

or in `BLOBBY_SANDBOX_ALLOWED_LOGINS` (comma-separated), which wins over the file. With an empty list,
every secret is refused with `login_not_allowed`. After a sign-in, blobby-sandbox checks that the command
signed in to the secret's account, and that it's on the list. `doctor` says how many logins are listed
and whether every secret's login is one of them, without naming them. Agents never edit this file.

### One sign-in per account at a time

GitHub accepts each 2FA code once. So the first request of a command or step for an account takes that
account's lock, until it ends, and a sign-in of the same account in another sandbox or process waits for it
("Waiting for another sign-in to github to finish"), for up to 2 minutes. Each 2FA code comes from a later 30-second period
than the last one given out; when the current one was used already, the sign-in waits for the next
("waiting 25 seconds for the next one"). The locks and the last period of each account live in
`~/.config/blobby/signins/` (mode 700, files mode 600). They don't coordinate across computers, so each
person uses their own test account.

## Drive a sandbox's desktop

```sh
blobby-sandbox ui t1 --app code-insiders --match chat   # visible, named elements of the accessibility tree
blobby-sandbox ui t1 <path>                             # press one of them; or: focus, set TEXT
blobby-sandbox ui t1 --wait --match Accounts --role 'push button'   # wait until it shows, in one call; --gone for until it goes
blobby-sandbox screenshot t1 --out shot.png
blobby-sandbox input t1 click 640 400                   # or: move X Y, type TEXT, key ctrl+l, scroll 0 3
blobby-sandbox record t1 start && blobby-sandbox record t1 stop --out repro.mp4
blobby-sandbox exec t1 -- xdotool getactivewindow       # anything else, as the desktop user, in its session
blobby-sandbox exec t1 --root -- apt-get install -y gimp # as root, for system changes
```

Commands get the desktop session's variables, `HOME`, and what the SDK's `exec({ env })` passes; never
this computer's environment. Credentials are refused even when passed (`env_blocked`): `GH_TOKEN`,
`GITHUB_*` and `GH_*`, `COPILOT_*`, `AZURE_*`, `ARM_*`, `AWS_*`, `NPM_TOKEN`, `npm_config_*`,
`SSH_AUTH_SOCK`, `GIT_ASKPASS`, `GIT_CONFIG_*`, `BLOBBY_SANDBOX_*`, and any name with `TOKEN`, `SECRET`,
`PASSWORD`, `API_KEY`, `PRIVATE_KEY`, `ACCESS_KEY`, or `CREDENTIAL` in it. Every backend checks this too.

Agents drive a desktop in two ways, and should pick one for the task:

- **Efficient: the accessibility tree.** `ui` finds and acts on UI by name, quickly and exactly. For
  directed work, such as following known repro steps.
- **Visual: screenshots.** A screenshot after every action, and `input` from what's on the screen, as a
  person would. Slower, but it notices what's inconsistent or out of place. For exploring and QA.

The pointer moves the way a hand moves a mouse: along a slight curve, fast in the middle and slow at the
ends, and a click holds the button for a moment. Hover effects and recordings look as they do for
people. `--instant` jumps instead, when speed matters more.

VS Code and Chrome publish their accessibility trees from the start. VS Code still works as it does out
of the box: the recipe sets `editor.accessibilitySupport` to `off`, so it doesn't take the tree for a
screen reader and switch to Screen Reader Optimized.

## Sandboxes on another machine

```sh
blobby-sandbox serve --host 127.0.0.1 --port 4100     # on the machine that runs sandboxes; prints a token
export BLOBBY_SANDBOX_SERVER=http://127.0.0.1:4100 BLOBBY_SANDBOX_TOKEN=<token>
blobby-sandbox start t1                               # on your computer: the same commands
```

Your secrets stay on your computer, which answers the sandbox's callbacks through the server; the server
sees only sealed values. A command's output goes through the server as the command writes it, and your
computer redacts it, so scripts must never print the values they get. The guest library withholds them
from a Node script's own output, and the server still controls the sandbox they're opened in, so use
only servers you trust with the test account. Screenshots and recordings come back as bytes, recipe folders go up as bytes,
and viewers go through the server at short-lived links that never hold the token. Put anything but
127.0.0.1 behind TLS.

## Use the SDK

The CLI and the canvas are thin wrappers around it:

```ts
import { connect, recipeRef } from '@rwoll/blobby-sandbox'

const sandboxes = connect()   // in this process; or connect({ server, token }) for `blobby-sandbox serve`
const sb = await sandboxes.start('t1', { recipe: await recipeRef('vscode-insiders'), onProgress: console.log })
const signin = await sb.exec(['vscode-signin'], { secret: 'github', onOutput: (chunk) => process.stdout.write(chunk.text) })
signin.result   // { github: { signedIn: true, verified: true } }; answered by a LocalResolver unless you pass one
const { png } = await sandboxes.screenshot('t1')
const { nodes } = await sandboxes.ui('t1', { match: 'Accounts' })
await sb.desktop.waitFor({ app: 'code-insiders', match: 'Accounts', role: 'push button' })   // waits in the sandbox; wait_timeout after 30s
```

## Callbacks and resolvers (`/callbacks`)

`@rwoll/blobby-sandbox/callbacks` has the callback protocol, sealing, and resolvers, for hosts that run
the engine themselves, such as a hosted controller. It needs no database, no Blobby app, and no agent
SDK.

- **Protocol.** A step asks for a callback by name; the engine relays a `CallbackRequest`
  (`sandbox`, `feature`, `step`, `stepName`, `id`, `name`, `sensitive`, and the step's one-time
  `publicKey`) to a `Resolver`, with a `ResolveContext`: the sandbox, the feature and step running now as
  the engine started them, the step's declared `uses`, and the `binding` behind the request's namespace
  (from `start({ bindings: { github: 'github-test' } })`). The answer is `{ value }` (identifiers only),
  `{ sealed }`, or a refusal, `{ error, code }`.
- **Sealing** (`seal`, `binding`): X25519, HKDF-SHA256, and ChaCha20-Poly1305, bound to the sandbox,
  step, request, and callback name, and opened by the step's `runtime/lib/blobby.mjs`. Sealing protects
  delivery; it doesn't authorize.
- **Authorization** (`authorize`): only requests from the running step, for callbacks it declared, with
  the declared sensitivity. The engine checks this before it asks the resolver, and resolvers check it
  again, then check that the binding exists and may be used.
- **`Resolver`**: `resolve(request, context)` returns an answer or a refusal, and must never put a
  value in a refusal. Optionally, `step(context, run)` wraps each step, so the resolver can hold a lock
  for the whole step; `checkResult(result, context)` checks the accounts a step's result claims and
  returns it with each login replaced by `{ signedIn: true, verified: true }`; and `redactor` lists the
  values it knows are secret. Without `checkResult`, the engine still replaces logins, with
  `verified: false`. A vault-backed resolver implements the same interface.
- **`LocalResolver`** reads `Secrets` (files and providers): the 2FA key stays in the resolver, and only
  codes made from it are sealed and sent. It enforces the [allowlist](#the-allowlist) for every secret,
  and
  [one sign-in per account](#one-sign-in-per-account-at-a-time). Its `checkResult` refuses a step that
  signed in to another account than the secret's (`wrong_account`) or a login not on the allowlist.
  Clients relaying from a server check results the same way: the engine sends each result to the
  client's resolver and shows only what comes back.
- **Audit**: `start({ onAudit })` and `exec({ secret, onAudit })` get an `AuditEvent` for every answer and refusal: the time, sandbox,
  feature, step, request, callback name, binding, outcome, refusal code, and whether it was sealed. Never
  a value.
- **Redaction**: `Redactor` replaces known secret values, in their common forms (without spaces, escaped
  in JSON, URL-encoded, and 2FA codes in two groups), in text, JSON, and errors. The engine passes step
  progress, results, and errors through the resolver's, and so does the client, for remote servers.
- **Other controllers** use `StepCallbacks` (or `answerCallback`) to answer, audit, and redact a step's
  requests the way the engine does.

Refusals have stable codes, which a step's error carries in its message:

| Code | Means |
|---|---|
| `wrong_step`, `not_declared`, `mismatch` | The request isn't from the running step, its step didn't declare it, or its sensitivity or key doesn't match |
| `no_resolver` | Nothing answers callbacks |
| `no_binding`, `binding_failed`, `no_field` | The secret doesn't exist, can't be read, or lacks the field |
| `forbidden` | A 2FA key was asked for; steps get `otp` codes instead |
| `not_sensitive` | A value other than an identifier was asked for in the clear |
| `login_not_allowed` | The secret's login isn't on the allowlist |
| `busy` | Another sign-in of the account held its lock too long |
| `invalid_key`, `unsealed` | The request's key is invalid, or a sensitive value was answered in the clear |
| `resolver_failed`, `refused` | The resolver failed, or refused without a code |

## Agent tools (`/tools`)

`@rwoll/blobby-sandbox/tools` has plain tool descriptors for driving a sandbox's desktop, for embedders
that run their own agents. They don't depend on any agent SDK. Each is `{ name, description,
inputSchema, createHandler }`: a zod schema, and a factory that binds a handler to a
`DesktopTarget`, one sandbox's desktop.

```ts
import { bindTools, engineTarget, toolsFor, toToolResultObject } from '@rwoll/blobby-sandbox/tools'

const tools = bindTools(toolsFor(['desktop', 'vscode-insiders']), engineTarget(engine, 't1'), { allowRoot: false })
const result = await tools.find((tool) => tool.name === 'desktop_screenshot')!.handler({})
toToolResultObject(result)   // { textResultForLlm, binaryResultsForLlm: [{ type: 'image', mimeType: 'image/png', data }], resultType }
```

| Tool | Does |
|---|---|
| `desktop_screenshot` | A PNG of the screen, as an image, with its size |
| `desktop_input` | `click`, `move`, `type`, `key`, or `scroll`, by screenshot coordinates |
| `desktop_ui` | Lists the accessibility tree's visible, named elements; with `path`, presses, focuses, or sets one |
| `desktop_exec` | Runs a command as the desktop user; as root only when the factory gets `allowRoot` |
| `desktop_record_start`, `desktop_record_stop` | Records the screen; the video stays in the sandbox |
| `desktop_media_read` | Reads a recording in chunks of up to 4 MiB; `readMedia` streams one for storage |
| `desktop_info` | The sandbox's name and state |

- **Targets.** `engineTarget(engine, name)` drives an engine in this process; `clientTarget(client,
  name)` drives one through `connect()`, locally or remotely. A hosted broker can implement
  `DesktopTarget` over its own procedures.
- **Only with a desktop.** `toolsFor(features)` returns the desktop tools only when the features include
  `desktop`.
- **Results.** Handlers never throw. They return `{ ok, text, json, binary, error? }`: `text` for the
  model, `json` for programs, and `binary` items (`{ type: 'image' | 'resource', mimeType, data }`, base64)
  for screenshots and recording chunks. `toToolResultObject` maps it to the Copilot SDK's tool result,
  `binary` to `binaryResultsForLlm`, without depending on it. `bindTools` adds each schema as JSON Schema,
  in `parameters`.
- **Errors** have stable codes: the engine's (such as `not_found`), and `invalid_input` and
  `root_not_allowed`. Input isn't idempotent, so every description and error tells the
  agent to take a fresh screenshot before acting again.

## How it works

- **Three parts.** The client (the CLI, the canvas, or your code) holds your secrets. The engine,
  `Sandboxes`, runs sandboxes on a backend. The two talk [tRPC](https://trpc.io), in the same process or
  over HTTP with `blobby-sandbox serve`; nothing assumes they share a disk.
- **Backends** run the machines. With **smolvm**, sandboxes are
  [smolvm](https://github.com/smol-machines/smolvm) micro-VMs with their own Linux kernel, run through
  [`smolmachines`](https://www.npmjs.com/package/smolmachines), smolvm's official SDK, which embeds the
  engine. They keep running after `blobby-sandbox` exits. Each viewer has its own random password,
  which `blobby-sandbox view` puts in the URL's fragment so it never reaches a server or a log. The
  engine asks the backend where the viewer is reached (`endpoint`), and standalone backends publish it
  on 127.0.0.1 only.
- **Ownership labels.** Every machine carries `blobby.dev/manager=standalone:<host-id>`, which the
  backend adds as its owner label, and the engine adds `blobby.dev/kind=desktop` and
  `blobby.dev/delete-after=<deadline>`. The host ID is random, made on first use, and kept in
  `~/.config/blobby/host-id`. A host lists and manages only machines with its own labels.
- **Bases**: the runtime's [`setup.sh`](../runtime/setup.sh) and the recipe's install a hidden base per
  recipe, from Ubuntu's, Google's, Node.js's, and the recipe's signed or checksummed downloads. The
  engine keeps no files about bases: it finds them by their labels (`blobby.dev/base`, the hash of what
  they install, and `blobby.dev/recipe`, `blobby.dev/image`, and `blobby.dev/runtime`). On a backend that
  takes snapshots, the base is a snapshot and new sandboxes are created from it. On smolvm, which
  branches running machines instead, the base is a running machine and new sandboxes are copies of it;
  a copy shows whether the base was finished, so two processes never use a half-installed base. A
  backend that does neither installs every sandbox from scratch. A change to a setup script makes a new
  base; old ones are removed once no sandbox needs them.
- **The runtime**: every sandbox gets [`runtime/`](../runtime) in `/opt/blobby/runtime`, including
  [`guest.py`](../runtime/guest.py), which does every desktop operation as JSON over plain commands. So a
  backend needs only to run commands and copy files to support everything, remote or not.
- **Steps**, and commands run with `--secret`, run in the background in the sandbox. The engine polls
  each one for progress, output, and callback requests, relays requests to the client, and writes the
  answers to a folder in memory that only the desktop user can read.
- **Sign-in**: `vscode-signin` signs in to GitHub in a throwaway headless Chrome, then clicks through VS
  Code's own GitHub sign-in, so VS Code keeps a real session; no token is injected. Running it again is
  safe: it checks first.

## Extending it

There are three extension points, and everything else is closed until someone needs it:

| | What it is | Where its code runs |
|---|---|---|
| **Recipe** | a folder: `recipe.json` and scripts | inside the sandbox |
| **Secret provider** | any program that prints a JSON object | on the client |
| **Backend** | a class that implements [`Backend`](../src/backend.ts) and passes the conformance suite | with the engine |

Backends live at their own subpaths and load only when chosen: `@rwoll/blobby-sandbox/smolvm` exports
`SmolvmBackend`, and `@rwoll/blobby-sandbox/docker` exports `DockerBackend`. The engine runs on any backend: `new Sandboxes(backend)`, and
`connect({ engine: async () => new Sandboxes(backend) })` for a client on it.

## The docker backend

`@rwoll/blobby-sandbox/docker` runs each machine as a Docker container. It talks to the Docker Engine API
on the daemon's socket with Node's own HTTP client: there's no Docker CLI and no other dependency, so it
also works inside a container under compose, with the socket mounted in.

**Where it finds Docker.** `DOCKER_HOST` when it is set, as `unix:///path/to/docker.sock` or
`tcp://host:port` (plain HTTP, for a daemon on a network you trust; `DOCKER_TLS_VERIFY`, `ssh://`, and
named pipes fail with `docker_host_unsupported`). Otherwise the first socket that exists of
`/var/run/docker.sock`, Docker Desktop's `~/.docker/run/docker.sock` and `~/.docker/desktop/docker.sock`,
and rootless Docker's `$XDG_RUNTIME_DIR/docker.sock`. It never reads Docker's CLI configuration or
contexts, and never sends registry credentials, so pull private images yourself first. It speaks
Engine API 1.41 (Docker 20.10) to 1.47, and uses the newest both sides speak.

**What a machine is.** A container named after the machine (the engine's names start with `blobby-`),
whose main process is `sleep infinity` under Docker's init, so it stays up whatever the image is, and
commands run with `exec`. `create` pulls a missing image first. A stopped machine keeps its files;
`remove` also removes its anonymous volumes. States are `created`, `running`, and `stopped` (an exited
container), and Docker's others, such as `paused`, as they are. A machine gets the CPUs it asks for, or all that Docker has
when that is fewer, as on a small Docker Desktop VM.

**Security.** Containers are never privileged, get no added capabilities, and have no host folders,
Docker socket, or devices mounted. Ports are published on `127.0.0.1` only. Machines run with
`no-new-privileges`, unless created with `root: true`, which lets the desktop user's `sudo` work; root in
a machine still has only Docker's default capabilities, under Docker's default seccomp profile. With
`commandSandbox: true`, and only then, a machine gets the command sandbox's seccomp profile and
`/dev/net/tun`. The profile is Docker's own default profile, pinned in the package (`seccomp/`, from
[moby/profiles](https://github.com/moby/profiles), Apache-2.0), with only the syscalls that bubblewrap,
`unshare`, and `nsenter` need to make and enter namespaces allowed: `clone`, `clone3`, `unshare`,
`setns`, `mount`, `umount`, `umount2`, `pivot_root`, the new mount API, `sethostname`, and
`setdomainname`. A process gets capabilities only inside namespaces it makes, so even root still can't
mount anything in the machine itself. The trade-off: user namespaces expose more of the kernel to code
in the machine, which is why Docker blocks them by default. Leave `commandSandbox` off for machines that
don't need VS Code's command sandbox.

**Chromium's sandbox.** Desktops run Chrome and VS Code, whose Chromium sandbox needs user namespaces,
or a setuid helper that `no-new-privileges` disables. A Docker machine allows neither, so at boot the
desktop finds that out and its launchers start those apps with `--no-sandbox`, leaving the machine as the
boundary. smolvm and Azure machines keep the sandbox.

**AppArmor.** On Linux hosts whose daemon applies AppArmor's `docker-default` profile, which denies the
mounts bubblewrap makes, the command sandbox can't work, so `commandSandbox: true` fails with
`docker_apparmor`, and `doctor` says so. To run it anyway, pass `providerOptions: { apparmor: 'unconfined' }`,
which runs that machine without AppArmor. It is never applied unless you pass it. Ubuntu 23.10 and later
also give unconfined processes no capabilities in the user namespaces they make, so bubblewrap still
fails (`loopback: Failed RTM_NEWADDR: Operation not permitted`) until the host sets
`kernel.apparmor_restrict_unprivileged_userns=0`; `doctor` reads that setting when the daemon runs on the
same Linux host. Change it only on a host you're willing to weaken, such as a throwaway CI runner. Docker
Desktop on macOS needs neither.

**Network.** It enforces two policies: `none` (Docker's `none` network: no network at all) and
`internet` (the default bridge, or the network in `providerOptions.network`). Docker can't enforce an
allowlist without a proxy, so `essential` and `{ allow }` fail with `network_unenforceable`, unless
`allowUnenforcedNetwork` lets them run unrestricted.

**Provider options** (`DockerProviderOptions`, in `CreateOptions.providerOptions`):

| Option | What it does |
|---|---|
| `network` | Attach the machine to this Docker network, such as the `desktops` network under compose, instead of the default bridge. No ports are published then: `endpoint()` returns the machine's address on that network and the guest port. |
| `apparmor: 'unconfined'` | Run the machine without AppArmor, for the command sandbox on Linux hosts with AppArmor. Only when you pass it. |
| `command` | `sleep` (the default) keeps the machine up with `sleep infinity`; `image` runs the image's own entrypoint and command instead. |
| `shmSizeMb` | The size of `/dev/shm` (default 512, which browsers need). |

**Resources.** `cpus` and `memoryMb` become Docker's CPU and memory limits, without swap. Docker doesn't
size a container's disk, so `storageGb` is ignored, and there is no GPU.

**Ports.** Ports are fixed when a machine is created; Docker can't publish one later, so there is no
`publish`. A port without a host port gets a free one each time the machine starts, and a stopped machine
publishes none.

**Commands.** `exec` runs as the image's user, or `user`, with stdin, streamed output, and the
environment you pass (never this computer's). `timeoutSeconds` wraps the command in `timeout` inside the
machine, so it ends with exit code 124 even if this process goes away. Cancelling with a `signal` kills
the command and everything it started, found by a marker variable in their environment.

**Files** stream in and out through Docker's archive endpoints, also on stopped machines. `writeFile`
creates missing parent folders owned like the file, and never changes existing ones; a stream of unknown
size is held in memory up to 8 MB, then in a private temporary file, because a tar header needs the size
first. `readFile` streams a file, or a byte range of it, without holding it in memory.

**Labels and limits.** Machines and snapshots carry the backend's owner labels (by default
`blobby.dev/manager=standalone:<host-id>`), your `labels`, `blobby.dev/delete-after`, and the idempotency
key; every lookup filters by the owner labels. An owner may run 3 machines and have 6 in all; more fail
with `limit_reached`. Raise them with `BLOBBY_SANDBOX_DOCKER_MAX_RUNNING` and
`BLOBBY_SANDBOX_DOCKER_MAX_TOTAL`, or `new DockerBackend({ limits })`.

**Snapshots** are images committed from a machine (paused for the moment it takes), tagged
`blobby-snapshot:<machine>-<time>`, with the owner labels on the image. They keep the machine's files,
not its memory or processes, and the base image's own command. `removeSnapshot` fails with `in_use`
while a container uses one.

**`doctor`** checks that Docker answers and which version and platform it runs, that the package has the
seccomp profile and the daemon applies seccomp, whether `/dev/net/tun` is there (Docker Desktop's VM has
it; on a Linux host it checks the device, and elsewhere it can't tell), whether AppArmor applies, and the
limits.

## The azure backend

`@rwoll/blobby-sandbox/azure` runs each machine as an Azure Container Apps sandbox, a micro-VM in a
sandbox group, through [`@azure/containerapps-sandbox`](https://www.npmjs.com/package/@azure/containerapps-sandbox),
the official SDK.

**Setting it up.** Deploy [`infra/azure/main.bicep`](../infra/azure/README.md) once, to make the sandbox
group and give your account its SandboxGroup Data Owner role. Then save its outputs in
`~/.config/blobby/azure.json`, which only you can read. The file names your Azure resources, so it is
never committed:

```json
{ "subscription": "00000000-0000-0000-0000-000000000000", "resourceGroup": "rg-contoso", "sandboxGroup": "sg-contoso", "location": "westus2" }
```

It signs in with the Azure CLI (`az login`), asking for tokens for that subscription, so it picks the
right account when the CLI is signed in to several. Messages never include the subscription ID.

**What a machine is.** A sandbox, with the machine's name in its `blobby.dev/name` label. `create`
builds a disk image from the container image the first time it is used (`ubuntu:24.04` is
`docker.io/library/ubuntu:24.04`, in about 10 seconds), and reuses it after. A sandbox then takes 1 to
2 seconds to create. Commands run as the user asked for, from `/`, with a plain `PATH`, the user's
`HOME`, and only the variables you pass, never the guest's own, such as its managed identity endpoint.
Stdin goes through a file in the guest's memory-only `/run`, removed once the command has opened it.
Commands that stream output, or may run longer than 4 minutes, run in the background and are polled
every second. Stopping keeps a sandbox's files. Sandboxes don't suspend when idle; the service deletes
one once it has been idle past its `deleteAfter`, as a backstop for reapers.

**Network.** `internet` is unrestricted, with TLS straight to each server. `essential` denies every
connection but still resolves names through the platform's DNS, so the backend can't enforce `none`.
`{ allow: [hosts] }` lets HTTPS reach those hosts, and `*.example.com` covers subdomains. Plain HTTP is
refused, even to allowed hosts. The platform enforces a restricted policy only through a proxy that
inspects TLS, so the backend always asks for it then. The proxy's certificate is in the guest's system
store, and commands get `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `REQUESTS_CA_BUNDLE`, which point
at it. Chrome and VS Code don't trust it yet, so desktops that sign in need `internet` for now.

**What it can't do yet.** Sandboxes take HTTP ingress only, so ports aren't published and the desktop
has no viewer: `start` says so, and `view` fails with `unsupported`. Use `screenshot`, `ui`, and `record`.
There is no `branch`, GPU, or `commandSandbox`, and writes go whole, not streamed.

**Snapshots** keep a sandbox's disk, with the owner labels and `blobby.dev/snapshot-of`. A machine from a
snapshot always has the snapshot's size, so `createFrom` with other `resources` fails with `unsupported`;
`blobby-sandbox start --cpus` or `--memory` then installs that sandbox from scratch, at the size asked for,
in a few minutes. `removeSnapshot` fails with `in_use` while a machine made from it exists.

**`doctor`** checks that `azure.json` is there, and that the CLI signs in with access to the sandbox group.

## The backend contract

[`src/backend.ts`](../src/backend.ts) is the contract (v2) every backend implements:

- **`capabilities()`** never changes for an instance; asking for something it lacks fails with
  `unsupported`, never silently. **`check()`** never throws, and its `checks` are what `doctor` prints.
- **Owners.** An instance stamps its owner labels on everything it creates, and sees only what has them.
- **`create`** takes an image, `resources`, `ports`, `labels`, `deleteAfter`, an `idempotencyKey`, a
  `network` policy, and `providerOptions`. Label values are at most 63 of `A-Z a-z 0-9 . _ : -`.
- **Network policies** (`none`, `essential`, `internet`, `{ allow }`) fail closed with
  `network_unenforceable`, unless `allowUnenforcedNetwork` is set.
- **`remove`** and **`stop`** are idempotent. **`exec`** returns non-zero exit codes; `timeoutSeconds`
  ends with 124 in the guest, and a `signal` rejects with `cancelled`.
- **Files:** `readFile` (a stream or byte range), `readAll`, `writeFile` (mode 644 and owner root by
  default), and `stat`. **`endpoint(name, port)`** says where a client reaches a guest port.
- **Optional:** `publish`, `branch`, and `snapshot`, `snapshots`, `removeSnapshot`, and `createFrom`.

| Capability | smolvm | docker | azure | `FakeBackend` |
|---|---|---|---|---|
| `branch` | yes | no | no | yes |
| `publish` | yes, on 127.0.0.1 | no: ports are fixed at create | no | yes |
| `ports` | yes | yes | no: HTTP ingress only | yes |
| `gpu` | yes | no | no | yes |
| `networkPolicies` | `internet` (others aren't verified yet) | `none` and `internet` | `essential`, `internet`, and `allow` | all four |
| `commandSandbox` | yes: a micro-VM has its own kernel | yes, with a pinned seccomp profile and `/dev/net/tun` | no, not verified yet | yes |
| `streamingFiles` | no: files move whole through the SDK | yes | no: reads stream, writes go whole | yes |
| `labels` | yes | yes | yes | yes |
| `stdin` | yes | yes | yes, through `/run` | yes |
| `snapshot` | no: smolvm sets labels only at create, so bases are branched instead | yes | yes | yes |

`FakeBackend` takes `capabilities` to turn any of them off, so code can be tested as it runs on each
backend. On smolvm, a copy keeps the labels of the machine it was copied from, so sandboxes copied
from a base have no deletion deadline.

## Testing backends

`@rwoll/blobby-sandbox/testing` loads no test runner and has:

- **`FakeBackend`**: an in-memory backend for the whole contract. It records every call in `calls`,
  answers commands with `onExec`, and turns capabilities off with `capabilities`. Backends sharing its
  `machines` with other `labels` act as other owners.
- **`backendConformance(target)`**: 22 cases of what the engine relies on from every backend. Cases for
  missing capabilities skip themselves, and each case cleans up after itself. Real backends need only an
  image with a POSIX shell, coreutils, and a `nobody` user, such as `ubuntu:24.04`.
- **`emulateCommand`**: answers the suite's commands the way Linux does, for fakes.

```ts
import { backendConformance, FakeBackend, type ConformanceTarget } from '@rwoll/blobby-sandbox/testing'

const target: ConformanceTarget = {
  setup: async () => {
    const backend = new FakeBackend({ labels: { owner: 'a' } })
    return { backend, other: new FakeBackend({ labels: { owner: 'b' }, machines: backend.machines }) }
  },
}

// Vitest
for (const check of backendConformance(target)) it(check.name, (context) => check.run(context))
// node:test
for (const check of backendConformance(target)) test(check.name, (t) => check.run(t))
```

The package runs the suite against `FakeBackend`, smolvm on a fake SDK, and docker on a fake Engine API.
To run it against real machines (each run labels its machines with a unique owner and removes them):

| Backend | Command | Notes |
|---|---|---|
| smolvm | `BLOBBY_SANDBOX_CONFORMANCE_SMOLVM=1 pnpm --filter @rwoll/blobby-sandbox exec vitest run conformance` | |
| docker | `BLOBBY_SANDBOX_CONFORMANCE_DOCKER=1 pnpm --filter @rwoll/blobby-sandbox exec vitest run docker` | Also checks `commandSandbox`; CI runs it |
| azure | `BLOBBY_SANDBOX_CONFORMANCE_AZURE=1 pnpm --filter @rwoll/blobby-sandbox exec vitest run azure` | Costs money for 3 to 4 minutes |

`pnpm --filter @rwoll/blobby-sandbox e2e` drives a real desktop through the SDK on the backend `doctor`
picks: a screenshot, the **Activities** button, a recording, a script, and `exec --secret` refused
without an allowlist. CI runs it on Docker.

## Errors

Every error has a stable code. With `--json`, the CLI prints `{"error": {"code", "message"}}` to stderr
and exits with 1; the SDK throws a `SandboxError` with `code`. Messages say what to do; this table is
for scripts and agents.

| Code | Means | What to do |
|---|---|---|
| `usage` | A command, option, or value is wrong | Read the message, or `blobby-sandbox --help` |
| `unknown_backend` | `--backend` or `BLOBBY_SANDBOX_BACKEND` names no backend | Use `smolvm`, `docker`, or `azure` |
| `backend_unavailable` | The backend can't be used here | Read the message, or pick another backend with `--backend` |
| `docker_unreachable` | Docker isn't running, or isn't at the socket it looked at | Start Docker Desktop or the daemon, or set `DOCKER_HOST` |
| `docker_permission` | This user can't open Docker's socket | On Linux, join the `docker` group and sign in again, or set `DOCKER_HOST` |
| `docker_host_unsupported` | `DOCKER_HOST` uses TLS, `ssh://`, or a named pipe | Use a `unix://` socket, or plain `tcp://` on a network you trust |
| `docker_too_old`, `docker_too_new` | Docker's Engine API is older than 1.41, or no longer speaks the version this package needs | Update Docker, or `@rwoll/blobby-sandbox` |
| `docker_platform` | The daemon runs Windows containers | Switch Docker to Linux containers |
| `docker_seccomp_missing` | The package's copy of the seccomp profile is missing | Reinstall `@rwoll/blobby-sandbox` |
| `docker_apparmor` | `commandSandbox` was asked for on a daemon that applies AppArmor's `docker-default` | Pass `providerOptions: { apparmor: 'unconfined' }` if you accept that (Ubuntu 23.10 and later also need `kernel.apparmor_restrict_unprivileged_userns=0`), or leave out `commandSandbox` |
| `docker_tun_missing` | The Docker host has no `/dev/net/tun`, which `commandSandbox` needs | `sudo modprobe tun` on the Docker host, or leave out `commandSandbox` |
| `docker_pull_failed` | Docker couldn't pull the image | Check the name; pull private images yourself first, with `docker pull` |
| `docker_port_in_use` | A host port asked for is taken | Pick another port, or leave the host port out |
| `docker_exec` | A command's output stream from Docker broke | Run the command again |
| `docker_archive` | Docker sent a file in a form the backend doesn't read | Read the message, and report it |
| `docker_failed` | Docker refused a request for another reason | Read the message |
| `limit_reached` | This owner already runs or has the most machines allowed (docker: 3 and 6) | Stop or remove one (`blobby-sandbox list`, then `stop` or `rm`), or raise the limit the message names |
| `smolvm_missing` | The `smolmachines` package isn't installed | `npm install -g smolmachines@1.31.0` next to the CLI, or add it to your project |
| `smolvm_<reason>` | smolvm failed, for example `smolvm_invalid_state` | Read the message; `blobby-sandbox doctor` checks this computer |
| `smolvm_exec` | A command's output stream broke | Run the command again |
| `smolvm_publish` | smolvm didn't say which host port it published | Start the sandbox again |
| `azure_not_configured` | There is no `azure.json`, or it lacks a field | Deploy `infra/azure/main.bicep` and save its outputs; see [The azure backend](#the-azure-backend) |
| `azure_sdk_missing` | The `@azure/containerapps-sandbox` package isn't installed | `npm install -g @azure/containerapps-sandbox@1.0.0-beta.1` next to the CLI, or add it to your project |
| `azure_cli_missing`, `azure_auth` | The Azure CLI isn't installed, or gave no token | Install it, then `az login` |
| `azure_forbidden` | The signed-in account can't use the sandbox group | Give it the SandboxGroup Data Owner role on the group |
| `azure_image` | Azure couldn't build a disk image from the container image | Check the image name; only public images work for now |
| `azure_exec` | A command couldn't start, or `stat` failed | Read the message |
| `azure_error` | The sandbox service failed a request for another reason | Read the message, and try again |
| `already_exists` | A machine with that name exists (and was made with another idempotency key, or none) | Pick another name, or remove it |
| `in_use` | A snapshot that machines were made from, or a machine that has copies, can't be removed yet | Remove those machines first |
| `unsupported` | The backend can't do what was asked, such as publish a port after create, or use the GPU | Read the message; `blobby-sandbox doctor --json` lists the backend's capabilities |
| `network_unenforceable` | The backend can't enforce the network policy asked for, so it fails closed | Ask for a policy it enforces, or use another backend |
| `not_published` | A guest port, such as the viewer's, isn't published, and the backend can't publish it now | Remove the sandbox and start it again |
| `invalid_options` | An option to the backend is invalid, such as a label or a read range | Read the message |
| `base_timeout` | A recipe's base didn't finish installing in another process | Start again; if it repeats, remove the `blobbybase-` machine it names |
| `invalid_id` | A recording ID isn't 8 to 64 lowercase hex characters | Use the ID `record stop` gave |
| `invalid_name` | A sandbox name isn't 1 to 24 lowercase letters, digits, and dashes | Pick another name |
| `not_found` | No sandbox, recording, step, or file has that name | `blobby-sandbox list` |
| `not_running` | The sandbox is stopped | `blobby-sandbox start <name>` |
| `not_set_up`, `not_ready` | The sandbox hasn't finished starting | `blobby-sandbox start <name>` again |
| `recipe_mismatch` | An existing sandbox was made with another recipe | Use a new sandbox for that recipe |
| `setup_failed` | Installing a base or sandbox failed | Read the log lines in the message, then start again |
| `session_failed`, `viewer_timeout` | The desktop session or its viewer didn't start | See the session log the message names |
| `step_failed`, `step_timeout` | A recipe step failed or ran too long; the sandbox still runs | Fix the cause, then `blobby-sandbox start <name> --steps` |
| `busy` | Another command holds the lock, or another sign-in of the account took too long | Try again when it finishes |
| `recording`, `already_recording`, `not_recording` | A recording is or isn't running | `blobby-sandbox record <name> stop`, or `start` |
| `capture_failed`, `input_failed`, `resize_failed` | The desktop couldn't take a screenshot, send input, or resize | Check that the session runs, with `blobby-sandbox view` |
| `stale_path`, `no_action`, `action_failed` | An accessibility path is out of date, or the element can't do that | Run `blobby-sandbox ui <name>` again |
| `wait_timeout` | `ui --wait` or `waitFor` found no matching element in time, or with `--gone`, one stayed | Take a screenshot to see what's on the screen |
| `guest_failed` | The sandbox's guest helper failed without saying why | Read the message |
| `transfer_failed` | A recording didn't arrive whole; it stays in the sandbox | Run `record stop` again |
| `cancelled` | The command was cancelled, or its `signal` aborted | Nothing |
| `invalid_recipe`, `unknown_recipe` | A recipe folder is invalid, or no built-in recipe has that name | Read the message |
| `no_secret` | A command or recipe needs a secret that isn't set | `blobby-sandbox secrets set <name>`, yourself, in a terminal |
| `invalid_secret`, `invalid_totp_key`, `invalid_config` | A secret, its 2FA key, an account file, or a config file is malformed, missing, or readable by others | Read the message, which never quotes a secret |
| `provider_failed` | A secret provider failed; its output is withheld | Run the provider yourself |
| `wrong_account` | A command or step signed in to another account than the secret's | Remove the sandbox, and check the secret |
| `login_not_allowed` | A secret's login, or the account a command signed in to, isn't in `allowedLogins` | List your test account in [`allowedLogins`](#the-allowlist), yourself; remove the sandbox if it signed in |
| `own_account` | The test account, or the account file's, is the one the GitHub CLI uses | Use a dedicated test account |
| `env_blocked` | A command was given a credential variable, such as `GH_TOKEN` | Leave it out; give it a secret with `exec --secret` |
| `needs_terminal` | `secrets set` needs a person at a terminal | Run it yourself |
| `invalid_key` | A sandbox sent a callback without a valid key | Start the sandbox again |
| `unauthorized`, `server_unreachable` | The server refused the token, or can't be reached | Check `BLOBBY_SANDBOX_SERVER` and `BLOBBY_SANDBOX_TOKEN` |
| `no_browser` | `view` couldn't open a browser | `blobby-sandbox view <name> --print` |
| `invalid_input`, `root_not_allowed` | A `/tools` handler got invalid arguments, or root without `allowRoot` | Read the message |
| `internal` | Something unexpected failed | Report it, with the message |

## License

[MIT](../LICENSE). `smolmachines` is Apache-2.0, and `playwright-core` is Apache-2.0; their licenses
ship in their npm packages. `seccomp/docker-default.json` is Docker's default seccomp profile from
[moby/profiles](https://github.com/moby/profiles), unchanged, under the Apache License 2.0 in
`seccomp/LICENSE`.
