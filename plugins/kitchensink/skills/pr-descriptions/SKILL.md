---
name: pr-descriptions
description: "Write or rewrite pull request and bug report titles and descriptions that a reader can skim in 30 seconds: what it looks like first (a short annotated video, or a screenshot when one frame makes it obvious), then the problem, repro, and user-facing change, with concrete examples. Use whenever creating, updating, or proposing a PR, filing a bug report or issue, or when asked to tighten, shorten, or clean up either."
---

# Pull request and bug report descriptions

A PR description is for two readers: the reviewer deciding what to look at, and
whoever reads the squash commit later. Both want to know **what was wrong, what
is different now, and what it looks like**. They do not want a log of how the
agent got there.

The diff already shows the code and CI already shows the checks. The description
covers what neither of those shows. For bug reports, see
[Bug reports](#bug-reports); the [Media](#media) and [Style](#style) rules apply
to both.

## Title

- Format: `area: what changes for the user`, e.g. `chat: don't start new chats with a harness disabled by policy`.
- Use the repository's existing area prefixes, such as microsoft/vscode's `chat:`, `sessions:`, and `mcp:`. Use sentence case, no trailing period, and keep it under about 72 characters.
- Describe the outcome, not the mechanism. Write `Keep the MCP registry policy when a refresh fails`, not `Add fallback cache to McpRegistryPolicyService`.

## Body

Use only the sections that apply, in this order. Most PRs need three or four.

1. **Issue link**: the first line, e.g. `Fixes https://github.com/microsoft/vscode/issues/345117`.
   Use `Fixes` only when merging closes the issue; otherwise use `Related:`.
2. **Summary**: one or two sentences with no heading. A reviewer who stops
   here should still know what the PR does.
3. **`## Before / After`**: the most persuasive section, so it comes first,
   right under the summary. Pick the form that fits:
   - UI: a short annotated before/after video, or a table of annotated
     screenshots when one frame shows the change (see [Media](#media)).
   - Behavior that varies by input: a matrix with ✓/✗ or the resulting value.
   - Text, output, or config: two short code blocks or a two-column table.

   Skip it only when nothing can be shown, such as a pure refactor.
4. **`## Problem`**: the user-visible symptom, concretely. Quote exact error
   text and UI labels. Say who hits it, such as users whose organization disables Claude.
   Add one sentence of cause only if it helps review.
5. **`## Repro`**: numbered steps, three to five. Include the exact setting,
   policy, or input needed:
   ```jsonc
   // /etc/vscode/policy.json
   { "Claude3PIntegration": false }
   ```
6. **`## What changes`**: user-facing behavior in bullets, not files or
   functions. For a new setting, policy, command, or API, show its exact name
   and a copy-pastable example value. Mention internals only when the reviewer
   needs them to judge risk, in one bullet.
7. **`## Notes`** (optional, at most three bullets): a workaround until this
   ships, a known follow-up with its link, or one deliberate non-change a
   reviewer would otherwise ask about.

### Examples beat explanation

Turn every abstract claim into a concrete one:

| Instead of | Write |
|---|---|
| "Improves separator handling in search." | "`handy commands` now finds `handy-commands`." |
| "Trailing whitespace could be lost on auto save." | "Typing `Hello `, pausing, then `world` produced `Helloworld`." |
| "Adds support for a new retry setting." | A `"retries": 3` JSON block and a table of what each value does. |
| "Updates wording for policy-disabled states." | A table of old label → new label. |

## Bug reports

A bug report is for the code owner deciding whether, and how, to fix it. Keep it
minimal: what it looks like, how to get there, and what you expected.

- **Title:** a short statement of the problem as the user sees it, such as
  `Inbox only offers Send Positive Feedback, with no way to send negative feedback`.
  No area prefix unless the repository uses one for issues.
- **Body, in this order:**
  1. The media: a short annotated video of the repro, or one annotated
     screenshot when a single frame makes the problem obvious (see [Media](#media)).
  2. One line on the problem.
  3. **Steps**: numbered, three to five, with the exact setting or input needed.
  4. **Expected** and **Actual**: one or two sentences each, quoting exact UI
     text.
  5. **Build:** the version, commit, and OS on one line, and any setting the
     repro needs.
- Leave out root-cause essays, local file paths, logs beyond the one line that
  matters, and how you found it. Link a related pull request or issue only if
  it helps the owner.
- Budget: 150 words of prose.

## Leave out

These are the parts that make PRs long and hard to read. Remove them, even when
you did the work:

- **Validation sections that list commands**, test counts, the OS or desktop used,
  commit SHAs tested, or "lint passed". CI reports this. If manual verification
  matters to the reviewer, use one sentence such as
  `Verified in Code OSS with the policy above.` The exception is a gap the
  reviewer must know about, such as tests that were not run. State it in one
  sentence near the top.
- **Test instructions that only run tests.** A manual "How to test" is useful
  only when it differs from Repro. Otherwise end Repro with "Repeat the steps:
  now …".
- **File-by-file or function-by-function change lists**, and anything else that restates the diff.
- **Process narrative**: "I first tried…", "a local agent will run validation",
  "the maintainer reports…", sandbox or `npm ci` trouble.
- **Hedges and disclaimers**: "this is not a claim that…", "to the best of my
  knowledge". State what is true and stop.
- **Long "Intentionally unchanged", "Scope", "Accepted gaps", or "Caveats" lists.**
  Keep at most one bullet in Notes, or none.
- **An H1 that repeats the title**, and the repository's PR template HTML comment.
- **The same point in several sections.** Say it once, in the best section.
- **Changelog edits** such as "Update: also handles X". When updating a PR, rewrite the body so it describes
  the current state.

## Length

These budgets cover prose. Repro steps and quoted messages count toward them.
Tables, code blocks, and media are extra.

| PR | Prose budget |
|---|---|
| Typo, rename, dependency bump, docs | 1–3 sentences, no headings |
| Bug fix | ≤ 250 words |
| Feature or behavior change | ≤ 350 words |

If you are over budget, cut sections before you cut examples.

## Media

Readers look at the picture before they read anything. Make it the first thing
they see, and make it obvious what to look at.

- **Put media first**: the Before / After section right under a PR's summary,
  and the screenshot or video at the top of a bug report.
- **Annotate** when the part that matters isn't obvious at a glance in a full
  screenshot: a box or arrow on it and a label of a few words, or a zoom. Use the
  `annotate` skill if it is available.
- **Lead with video.** A short video of the repro shows what a still can't:
  what you did, what happened, and what didn't. Use a still instead only when one
  frame makes the problem obvious at a glance, such as a wrong label, a typo, or
  a misaligned control. Subtle problems, anything that moves or changes (focus,
  drift, flicker, nothing happening after a click), and multi-step repros always
  get a video.
- **Make the video easy to follow**: trim it to the repro, 30 seconds or less,
  speed up the waits, caption each step, and mark what to look at. Upload it as
  MP4 and put the uploaded URL on its own line, which GitHub plays inline. Put
  the captions under it in `<details><summary>Transcript</summary>…</details>`.
  Leave out stills that repeat the video.
- **Redact before uploading**: account names and avatars, email addresses,
  tokens, and private paths, even in test accounts. Look at the rendered file
  before you upload it.
- Put screenshots and videos **in the body**, not in a comment, so they become
  part of the squash commit. Upload them with the `gh` CLI, never through a
  browser. Use a media-upload skill if one is available.
- Give every image alt text that states what it shows, e.g.
  `alt="After: New Chat opens a Local chat with a working input"`. Set
  `width="600"` or less so tables fit.
- Show the two or three images that matter. Put the rest in
  `<details><summary>More screenshots</summary>…</details>`.

## Style

- Write from the user's point of view: "Uninstall is disabled", not
  "`isUninstallable()` returns false".
- Bold UI labels as they appear (**New Chat**, **Customizations > Browse**).
  Wrap settings, policies, commands, and values in backticks.
- Use short sentences and plain words, with no marketing tone.
- Write GitHub references as full URLs in the body.
- Keep the existing rules on attribution and private information (never customer
  names). This skill only shapes the description.

## Before publishing

1. Read only the title and summary. Do they say what changed for the user?
2. Is there at least one concrete example: a screenshot, value, quoted message, or table?
3. Is the media first, a video unless one frame makes it obvious, annotated, and redacted?
4. Delete every line in [Leave out](#leave-out).
5. Is the prose within the length budget?
6. Write the body to a file and pass it with `--body-file`, so the shell can't
   change it. Quote label names that contain spaces.
7. If a tool for proposing PR drafts is available, save the draft there before
   creating or updating the PR.

For full examples, see [references/examples.md](references/examples.md).
