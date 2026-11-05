---
name: agents-qa
description: "Run an unattended QA pass of the VS Code Agents window on the latest Insiders in a disposable desktop sandbox, driven with the blobby-sandbox CLI. It self-hosts recently merged microsoft/vscode pull requests plus one exploratory area, then writes findings for the Agents QA triage canvas. Use when a scheduled automation or the user asks for an Agents QA run, or when a fix or investigation session needs to reproduce or verify an Agents window bug in a sandbox."
---

# Agents QA run

A run self-hosts the VS Code Agents window the way a careful user would and reports what it finds. It starts a fresh desktop sandbox with `@rwoll/blobby-sandbox`, updates Insiders to the latest build, and signs it in to the GitHub test account. Then it tests the user-facing pull requests that are in this build but weren't in the last run's, and explores one area beyond them. Each finding gets repro steps, screenshots, and matching GitHub issues.

The user triages the results in the **Agents QA** canvas (`rwoll-agents-qa`), which reads what you write:

```text
~/agents-window-qa/                  (or $AGENTS_QA_ROOT)
  runs/<run>/findings.json           this run, in the format in references/findings-format.md
  runs/<run>/REPORT.md               the human-readable report
  runs/<run>/screenshots/, videos/   media the findings point to
  triage.json                        the user's decisions; read it, never write it
```

`<skill>` below means this skill's folder, which holds `scripts/` and `references/`. Every `blobby-sandbox` command takes `--json`; use it whenever you read a command's output, and when one fails, read `error.code` and `error.message`.

## Ground rules

- **Unattended.** Nobody is watching. Never call `ask_user`. Make the pragmatic choice and note it in the report's log.
- **Report only.** Never file issues, comment on GitHub, open pull requests, push, or message other sessions. The user decides what happens next in the canvas.
- **Budget.** Stop testing 75 minutes after you start (or at the limit the automation's prompt gives) and spend the rest writing up. A short, accurate report beats an unfinished one.
- **Only merged work.** Test pull requests merged into `microsoft/vscode` `main` that are in the installed build, never open ones.
- **Stay in your lane.** Use only the sandbox named `agents-qa`; leave other sandboxes alone. Run apps and repro steps in the sandbox, never on this machine. Write only under the run folder. Never mention customer names.
- **Never handle secrets.** The user enters the test account once, in their own terminal, with `blobby-sandbox secrets set github`. Never run `blobby-sandbox secrets`, and never read, print, or store tokens, passwords, or 2FA codes. Never write the test account's name; call it "the test account".
- **Save as you go.** Rewrite `findings.json` after every finding, so a crash still leaves results. Always write it atomically: write `findings.json.tmp`, then `mv` it over `findings.json`.

## 1. Start the run

```sh
ROOT="${AGENTS_QA_ROOT:-$HOME/agents-window-qa}"
RUN_ID="$(date -u +%Y-%m-%d-%H%M)"
RUN="$ROOT/runs/$RUN_ID"
mkdir -p "$RUN/screenshots" "$RUN/videos" "$RUN/.tools"
```

Write `findings.json` with `"status": "running"`, `startedAt`, and no findings yet, then start `REPORT.md` from the outline in [references/report-format.md](references/report-format.md).

## 2. Learn what is already known

```sh
node <skill>/scripts/known.ts
```

It prints JSON with:
- `previousBuild`: the build the last complete run tested. Step 5 picks this run's PRs relative to it.
- `nextArea`: the exploratory area explored least recently. Use it unless the automation's prompt names one.
- `known`: every earlier finding with its `key`, title, latest status, and the user's `decision`.

Use `known` throughout the run:
- **Same problem, same key.** When you see a known problem again, reuse its `key` and set `status` to `still-reproduces`.
- **Suppressed findings are never reported again**, even if you see them.
- **Re-check what should be fixed.** These are findings whose fix PR has merged and is in this build, and open high or medium findings. Report each as `still-reproduces` or `fixed`.

## 3. Start the sandbox

`blobby-sandbox` runs the desktop, on the backend `blobby-sandbox doctor` picks: Azure when `~/.config/blobby/azure.json` sets it up, else smolvm on an Apple silicon Mac or on Linux with KVM, otherwise Docker. Azure has no live viewer; screenshots and recordings work. Add `--backend <name>` to every command when the automation's prompt names one.

1. **Check this machine.** If `blobby-sandbox` isn't on `PATH`, end the run as failed (step 10) and say to install it with `node <skill>/scripts/install-tools.ts blobby-sandbox`; don't install it yourself during a run. Then run `blobby-sandbox doctor --json`. If Docker is the backend and isn't running, run `open -a Docker` and wait up to two minutes. If a check still fails, end the run as failed with its message. If only the `github` secret is missing, say in the error that the user has to run `blobby-sandbox secrets set github`.
2. **Start fresh.** Remove the sandbox an earlier run left, so every run tests a clean first-run experience: `blobby-sandbox rm agents-qa --json`. If there is none, carry on.
3. **Start it and sign in:**
   ```sh
   blobby-sandbox start agents-qa --recipe vscode-insiders --resolution 1600x1000 --json
   blobby-sandbox exec agents-qa --secret github --json -- vscode-signin
   ```
   `start` returns once the desktop is ready: Ubuntu with GNOME, Chrome, VS Code Insiders updated to the newest build, git, and common developer tools. VS Code's and Copilot's command sandbox works there, as on a developer's machine. `vscode-signin` signs Insiders in to the test account; its `result` is `{ "github": { "signedIn": true, "verified": true } }` when that worked. If it fails, read the end of its `stdout` and retry at most once (each attempt uses a single-use 2FA code), then carry on signed out and note that it limited the run.
4. **Create three helpers:**
   ```sh
   printf '#!/bin/sh\nexec blobby-sandbox exec agents-qa -- bash -lc "$*"\n' > "$RUN/.tools/d"
   printf '#!/bin/sh\nexec blobby-sandbox input agents-qa "$@"\n' > "$RUN/.tools/in"
   printf '#!/bin/sh\nblobby-sandbox screenshot agents-qa -o "%s/screenshots/$1.png" --json >/dev/null && echo "%s/screenshots/$1.png"\n' "$RUN" "$RUN" > "$RUN/.tools/shot"
   chmod +x "$RUN/.tools/d" "$RUN/.tools/in" "$RUN/.tools/shot"
   ```
   - `"$RUN/.tools/d" '<command>'` runs a command as the desktop user, in the desktop session. For system changes, use `blobby-sandbox exec agents-qa --root -- <command>`.
   - `"$RUN/.tools/shot" 07-short-name` saves a screenshot and prints its path. Then **view** it to see the screen.
   - `"$RUN/.tools/in" click 640 400` (`--button right`, `--double`), `"$RUN/.tools/in" type 'some text'`, `"$RUN/.tools/in" key ctrl+l`, and `"$RUN/.tools/in" scroll 0 3 --at 640,400` act like a person at the mouse and keyboard.
5. **Drive it from screenshots.** Take a screenshot after every action and work from what's on the screen, not assumptions. When you can't place something by eye, find it in the accessibility tree, `blobby-sandbox ui agents-qa --app code-insiders --match "<text>" --json`, and click the center of its box. List windows with `"$RUN/.tools/d" 'wmctrl -l'`.

## 4. Check the Insiders build

1. `start` updated Insiders to the newest build in Microsoft's repository, and `info.insiders` in its result is that version. If its progress said it couldn't update, run `blobby-sandbox exec agents-qa --root -- vscode-update` once. If that fails too, install the newest build directly, then open Insiders again with `"$RUN/.tools/d" vscode-open`:
   ```sh
   ARCH="$(blobby-sandbox exec agents-qa -- dpkg --print-architecture)"   # arm64 or amd64
   PLATFORM=$([ "$ARCH" = arm64 ] && echo linux-deb-arm64 || echo linux-deb-x64)
   "$RUN/.tools/d" "curl -fsSL -o /tmp/insiders.deb https://update.code.visualstudio.com/latest/$PLATFORM/insider"
   "$RUN/.tools/d" 'wmctrl -c "Visual Studio Code"; sleep 5'
   blobby-sandbox exec agents-qa --root -- sh -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/insiders.deb'
   ```
2. Record `"$RUN/.tools/d" 'code-insiders --version | head -2'`: the version (first line) and commit (second line) go in `findings.json` as `build`.
3. If the title bar still shows **Update**, a build came out after the one in the repository. Note it in `scope.notes`, not as a finding.

## 5. Choose the pull requests

```sh
node <skill>/scripts/pick-prs.ts <build commit> --out "$RUN/prs.json"
```

It lists every PR merged into `main` whose merge commit is in this build but wasn't in the last run's build (or, on a first run, the build of 24 hours earlier). Choosing by build, not by date, means no PR falls between runs, and PRs merged after this build was made wait for the next run. Each PR has a `relevance` hint from the files it changed: `agents-window`, `other`, `test-only`, or `engineering`.

- Test the user-facing ones: changes you can see or use in the Agents window, mostly among `agents-window`, though telemetry, refactoring, and test changes there are not user-facing. At most about 15, the most user-visible first.
- In `findings.json`, record:
  - `scope.base`: the script's `base` (`commit`, `version`, `run`).
  - `scope.since`: the base's `date`.
  - `scope.prs`: the PRs you tested.
  - `scope.skipped`: every other PR in `prs.json`, each with a short reason, such as "Telemetry only", "Test only", "Engineering", "Not in the Agents window", or "Over the time budget".
  - `scope.notes`: how many merged PRs aren't in this build yet (`notYetInBuild`).
- If there are no PRs, Insiders hasn't shipped a new build since the last run. Say so in `scope.notes` and spend the run on exploration and re-checks.

## 6. Self-host

1. **First run, as a non-coder.** The sandbox comes with git and other developer tools, but a non-coder's Ubuntu machine doesn't have them. Remove git first: `blobby-sandbox exec agents-qa --root -- apt-get remove -y git`. Then open the Agents window from the Welcome page as a new user would, go through onboarding, and try a simple non-coding request in a documents folder. Note any friction for someone who doesn't code: missing tools without a guided install, jargon, or dead ends. Then reinstall git (`apt-get install -y git`, as root) and anything else deeper features need, and create a small repository, such as `~/demo` with one commit on `main`.
2. **Record the pass:** `blobby-sandbox record agents-qa start --max-seconds 1800 --json`. If you go longer, stop it (step 9) and start another, numbering the files in order (`01-pass.mp4`, `02-pass.mp4`).
3. **Each pull request.** Use the feature it changed the way a user would, including edge cases next to it. If it works, add it to `verified` with a one-line note.
4. **The exploratory area** (`nextArea`). Spend about 20 minutes there.
5. **Re-checks** from step 2.

Look for bugs, visual inconsistencies (alignment, truncation, contrast, focus, theming), confusing copy and jargon, dead ends and silent failures, unhelpful errors, broken keyboard paths, and friction for people who don't code. For a silent failure, check the logs: **Developer: Show Logs** in the window, or the files under `~/.config/Code - Insiders/logs/` in the sandbox.

## 7. Write each finding

Add each finding to `findings.json` as soon as you've confirmed it, in the format in [references/findings-format.md](references/findings-format.md):

- **`id`:** short and numbered within the run (R1, R2, …). **`key`:** a stable kebab-case slug for the problem, such as `merge-changes-silent-failure`. Reuse the key of a known finding for the same problem.
- **`severity`:**
  - `high`: a core flow is broken, data could be lost, or there's no workaround.
  - `medium`: broken or misleading, but there's a workaround.
  - `low`: a minor bug or confusing behavior.
  - `polish`: cosmetic.
- **`repro`:** setup, numbered steps, expected and actual results, precise enough that the code owner can reproduce it on their own machine. Include exact UI labels and the commands that create the setup.
- **`media`:** the screenshots that show it, labeled (`Before: Merge confirmation`), most telling first: whoever files the issue or PR leads with the first entry. Number screenshot files in the order you take them (`07-merge-error.png`). When the problem plays out over time (flicker, a wrong transition, a delay, a sequence of steps), a still can't show it, so record a short clip and list it first: stop the pass recording into the next numbered `NN-pass.mp4`, run `blobby-sandbox record agents-qa start --max-seconds 60 --json`, reproduce it, stop into `"$RUN/videos/<id>-<key>.mp4"`, then start the pass recording again. Screenshots show the test account's avatar and name, so whoever files redacts them; keep them out of the frame when you can.
- **`prs`:** the merged pull requests involved. **`owner`:** optionally, the code's most active recent author (`git log -n 20 --format='%an' -- <path>` in `~/code/vscode`) and why.
- **`recommendation`:** what you'd decide, with one sentence of reason:
  - `fix`: clear, contained, and user-facing, so an agent can fix it and verify it live.
  - `issue`: needs the owner's judgment, or is too big.
  - `investigate`: the cause is unclear or it may be a regression.
  - `tracked`: an existing issue covers it exactly.
  - `suppress`: by design, or only happens in this sandbox.

Don't report problems caused by the test setup itself (the sandbox backend, software rendering, missing command-sandbox prerequisites) unless a real user would also hit them.

## 8. Match existing issues

As findings come in, launch a background `research` subagent with model `gpt-6-sol` to find existing GitHub issues for them. Prompt it:

> You are matching QA findings from self-hosting VS Code Insiders <version> (commit <commit>, Linux) against existing GitHub issues. Search microsoft/vscode, open AND closed, with the gh CLI (for example `gh search issues --repo microsoft/vscode "<terms>" --json number,title,state,url --limit 20`, then `gh issue view`). Try several phrasings per finding and read promising hits to confirm them. Do NOT create, comment on, or change issues. For each finding, classify it as Exact, Related, or None found, with up to 3 full issue URLs, each with its state and a one-line reason. Also flag any merged PR, issue comment, or code comment that says the behavior is intended, with its URL. Return Markdown, without an attribution footer.
>
> Findings: <id, one line each with the key details>

Send it later findings with `write_agent`. Record each match in the finding's `matches`: `duplicate` for an exact match, otherwise `related`. When the subagent finds the behavior is intended, add that link as `related` with a note saying so, and recommend `suppress` or `issue`. Before writing up, wait up to 10 minutes for the subagent's results.

## 9. Write the report

1. Stop the recording into the run folder, `blobby-sandbox record agents-qa stop -o "$RUN/videos/01-pass.mp4" --json`, and add it to the run's `media`.
2. Finish `REPORT.md` as [references/report-format.md](references/report-format.md) describes, with screenshots inline.
3. In `findings.json`, set `"status": "complete"`, `finishedAt`, `summary` (2 to 4 sentences: what you tested, the most important findings, and what still reproduces), and `verified`.
4. Check the file, and fix every problem it reports:
   ```sh
   node <skill>/scripts/check-run.ts "$RUN"
   ```
5. Stop the sandbox with `blobby-sandbox stop agents-qa --json`; don't remove it, so it can be inspected. The next run removes it.

## 10. If the run can't finish

Set `"status": "failed"` and a one-line `error`, keep the findings you have, and explain in `REPORT.md`. Then run the checker, and stop the sandbox if it started.

## Finish

Register `REPORT.md` with `add_artifact_or_reference`. End with one short paragraph: the build, how many findings (new, still reproducing, fixed), the most important one, and that they're ready to triage in the Agents QA canvas.

## Verify a fix in a sandbox

Fix and investigation sessions that the Agents QA canvas starts use this section. Reproduce first, then build Code OSS from your branch inside a sandbox and walk the same repro steps. The full procedure is in [references/verify-a-fix.md](references/verify-a-fix.md).
