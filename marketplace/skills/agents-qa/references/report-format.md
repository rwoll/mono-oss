# REPORT.md outline

The report is for people: the user skims it, and code owners use its repro steps. Keep it plain and precise, with screenshots inline. `findings.json` holds the same findings for the canvas, so the two must agree.

```markdown
# Agents window QA, <date> (<run id>)

- **Build:** VS Code Insiders <version>, commit `<commit>`. <OS, architecture>, Ubuntu 24.04 GNOME (X11) in a <smolvm or Docker> sandbox, 1600x1000.
- **Account:** the GitHub test account, signed in to a fresh sandbox.
- **Setup:** git installed after the first-run checks; `~/demo` is a git repository with one commit on `main`. Other setup is given per finding.
- **Scope:** user-facing PRs merged into `microsoft/vscode` `main` since <since> that are in this build (<n> of <m>), plus exploratory testing of <area>.

## Summary

<2 to 4 sentences: what you tested, how many findings, what matters most.>

**Most important**

1. **R4 🔴 <title>.** <one sentence>
2. …

**Verified working:** <PRs, one phrase each>.

**Still reproduces from earlier runs:** <keys or titles>.

| # | Sev | Area | Finding | Existing issue |
|---|---|---|---|---|
| R4 | 🔴 | Customizations | <short title> | Related: <full issue URL> |

**Video:** [01-pass](videos/01-pass.mp4)

## Findings

Severity: 🔴 high, 🟠 medium, 🟡 low, ⚪ polish

### R1 🟡 <title>
- **Repro**
  - Setup: <setup>
  - Steps:
  1. <step>
  2. <step>
  - Expected: <expected>
  - Actual: <actual>
- PRs: <full URLs, if any>
- Existing issues: <full URLs with Related or Same, or "None found">
- Screenshots: [07-short-name](screenshots/07-short-name.png)

![07-short-name](screenshots/07-short-name.png)

### ✅ Verified
- **<PR URL>, <what it does>:** <what you checked>. [11](screenshots/11-drag.png)

### ♻️ Still reproduces from earlier runs
- **<key>:** <one line>. [05](screenshots/05-x.png)

### Fixed since earlier runs
- **<key>:** <one line on what now works>.

## Log

- 09:02 Fresh sandbox on Insiders <old version>; installed <new version>.
- 09:05 …
```

Write every GitHub issue and pull request as a full URL. Link screenshots with paths relative to the report.
