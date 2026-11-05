# Run file format

Each run writes `runs/<run id>/findings.json` under the QA folder (`$AGENTS_QA_ROOT`, default `~/agents-window-qa`). The Agents QA canvas reads it and shows a clear error when it doesn't match this format, so run `scripts/check-run.ts` before you finish.

Write the file atomically every time: write `findings.json.tmp` in the same folder, then `mv` it over `findings.json`.

## findings.json

```json
{
  "format": "agents-qa-run",
  "version": 1,
  "id": "2026-10-30-0900",
  "status": "complete",
  "startedAt": "2026-10-30T09:00:12Z",
  "finishedAt": "2026-10-30T10:24:40Z",
  "build": { "version": "1.145.0-insider", "commit": "f8c98dc6a2efcf8e86977254e1d4cf56b2542dbc" },
  "environment": "linux-arm64, Ubuntu 24.04 GNOME (X11) in a smolvm sandbox, 1600x1000, signed in as the test account",
  "scope": {
    "since": "2026-10-29T04:39:53Z",
    "base": { "commit": "206844b5537c1b7582f6e81b41e1c5402c7e7fbc", "version": "1.145.0-insider", "run": "2026-10-29-0500" },
    "prs": ["https://github.com/microsoft/vscode/pull/344939"],
    "skipped": [{ "pr": "https://github.com/microsoft/vscode/pull/344832", "reason": "Telemetry only, nothing to see" }],
    "area": "Customizations",
    "notes": "76 merged PRs are not in this build yet; the next run picks them up."
  },
  "summary": "Self-hosted 12 merged PRs and Customizations on Insiders f8c98dc6. MCP gallery installs still fail (R4), and Merge Changes fails silently when main has uncommitted changes (R1).",
  "report": "REPORT.md",
  "media": [{ "path": "videos/01-pass.mp4", "label": "The whole pass" }],
  "findings": [
    {
      "id": "R1",
      "key": "merge-changes-silent-failure",
      "title": "Merge Changes fails with no message when main has uncommitted changes",
      "severity": "high",
      "area": "Worktrees",
      "status": "new",
      "summary": "The recommended worktree path dead-ends: the merge fails and only the logs say why.",
      "repro": {
        "setup": "`~/demo` is a git repository with one commit on `main` and uncommitted changes.",
        "steps": ["Start a session in `demo` with **New Worktree** and send `Add a multiply function`.", "Click **Merge Changes**, then confirm."],
        "expected": "The merge succeeds, or an error says to commit or stash the changes in `main` first.",
        "actual": "The button spins for about 11 seconds, then nothing happens. `main` is unchanged."
      },
      "prs": ["https://github.com/microsoft/vscode/pull/344870"],
      "media": [
        { "path": "screenshots/63-merge-changes.png", "label": "Before: merge confirmation" },
        { "path": "screenshots/65-after-merge-wait.png", "label": "Before: no feedback after merging" }
      ],
      "matches": [
        { "url": "https://github.com/microsoft/vscode/issues/316336", "relation": "related", "state": "open", "note": "Merging back with local edits; not the silent failure" }
      ],
      "owner": { "login": "octocat", "reason": "Most recent commits to the changeset operations code" },
      "recommendation": { "outcome": "fix", "reason": "Clear repro and a contained change: show the error with a Stash and Merge action." }
    }
  ],
  "verified": [{ "pr": "https://github.com/microsoft/vscode/pull/344939", "note": "Drag to reorder sessions works." }]
}
```

### Fields

| Field | Required | Notes |
| --- | --- | --- |
| `format`, `version` | yes | Always `"agents-qa-run"` and `1`. |
| `id` | yes | The run folder's name: letters, digits, `.`, `_`, `-`, up to 64 characters. |
| `status` | yes | `running` while testing, then `complete` or `failed`. A run still `running` after six hours shows as stopped. |
| `startedAt`, `finishedAt` | `startedAt` | ISO times. |
| `build` | no | `version` and `commit` from `code-insiders --version`. |
| `environment` | no | One line: OS, architecture, desktop, sandbox backend, resolution, and whether it was signed in. Say "the test account", never its name. |
| `scope` | no | `since` (ISO time the base build was made), `base` (the build the PR list is counted from: `commit`, `version`, and the `run` that tested it), `prs` (https URLs you tested), `skipped` (every other PR in this build and not the base: `pr` and a short `reason`), `area` (the exploratory area), `notes`. `scripts/pick-prs.ts` gives `base` and the PR list. |
| `summary` | no | 2 to 4 sentences of Markdown. |
| `error` | when failed | One line on why the run failed. |
| `report` | no | Path of the report, relative to the run folder. Default `REPORT.md`. |
| `media` | no | Run-wide recordings and screenshots: `path` and optional `label`. |
| `findings` | no | Up to 200. See below. |
| `verified` | no | Pull requests that work: `pr` (https URL) and a one-line `note`. |

### Findings

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Short label within the run, such as `R4`. |
| `key` | yes | Stable kebab-case slug, 2 to 80 characters of `a-z`, `0-9`, `-`. **Reuse the key** when a later run sees the same problem; the canvas merges findings by key and keeps your decision. |
| `title` | yes | One line, up to 200 characters, stating the problem. |
| `severity` | yes | `high`, `medium`, `low`, or `polish`. |
| `area` | no | Such as `Customizations`, `Sessions list`, `Composer`, `Changes`. |
| `status` | no | `new` (default), `still-reproduces` (a known key seen again), or `fixed` (a known key that no longer reproduces). |
| `summary` | no | Markdown: what is wrong and why it matters. |
| `repro` | no | `setup` (Markdown), `steps` (array of Markdown strings, without numbers), `expected`, `actual`. |
| `prs` | no | https URLs of the merged pull requests involved. |
| `media` | no | `path` (relative to the run folder, or absolute inside the QA folder) and `label`, most telling first: issues and PRs lead with the first entry. PNG, JPEG, GIF, and WebP show inline; MP4, WebM, and MOV play inline. Other files are listed. Files outside the QA folder are ignored. |
| `matches` | no | Existing issues, or PRs that say the behavior is intended: `url`, `relation` (`duplicate` or `related`), `state` (`open` or `closed`), `note`. |
| `owner` | no | `login` (GitHub user name, without @) and `reason`. |
| `recommendation` | no | `outcome` (`fix`, `issue`, `investigate`, `tracked`, or `suppress`) and a one-sentence `reason`. |

Markdown in these fields supports paragraphs, lists, fenced code, `code`, **bold**, *emphasis*, and https links. Raw HTML shows as text.

## triage.json (read only)

The canvas writes the user's decisions to `triage.json` in the QA folder. Read it to learn what was decided; never write it.

```json
{
  "format": "agents-qa-triage",
  "version": 1,
  "items": {
    "merge-changes-silent-failure": {
      "decision": "fix",
      "note": "Show the error with a Stash and Merge button.",
      "state": "done",
      "links": [{ "url": "https://github.com/microsoft/vscode/pull/345058", "label": "Draft PR", "kind": "pr" }],
      "updatedAt": "2026-10-30T11:02:00Z"
    }
  },
  "settings": { "fixModel": "claude-opus-5.5" }
}
```

`decision` is `fix`, `issue`, `investigate`, `tracked` (with `trackedUrl`), `suppress`, or `null`. `state` is `draft` (not sent yet), `sent`, `working`, `done`, or `failed`.

## Outcome files

Fix and investigation sessions started from the canvas report back by creating one file each in `outcomes/` under the QA folder. The canvas merges them into `triage.json` and moves them to `outcomes/applied/`. The session's brief gives the exact file name.

```json
{
  "format": "agents-qa-outcome",
  "version": 1,
  "key": "merge-changes-silent-failure",
  "state": "done",
  "links": [{ "url": "https://github.com/microsoft/vscode/pull/345058", "label": "Draft PR", "kind": "pr" }],
  "detail": "Shows the error with a Stash and Merge action. Validated live on Ubuntu 24.04 arm64."
}
```

`state` is `working`, `done`, or `failed`. Each link has exactly one of `url` (https or `agent-host-session://`) or `path` (an absolute file path), plus `label` and `kind` (`pr`, `issue`, `session`, `file`, or `other`).
