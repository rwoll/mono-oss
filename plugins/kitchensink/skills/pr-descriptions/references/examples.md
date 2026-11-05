# Examples

Real microsoft/vscode PRs rewritten with this skill. The originals were 5–8k
characters each. Use them for shape and tone, not as templates to fill in.

## Bug fix with UI

Rewritten from https://github.com/microsoft/vscode/pull/345207. Removed: the
Validation section (commands, SHAs, test counts), the "How to test" steps that
repeated Repro, the resolver internals, and the draft-restore edge cases. The
before/after table moved up, right under the summary.

````markdown
Fixes https://github.com/microsoft/vscode/issues/345117

New chats no longer open in a Claude or Codex harness that your organization has disabled. They fall back to Local, or to Copilot when Local isn't allowed.

## Before / After

| | Before | After |
|---|---|---|
| Claude disabled, **New Chat** (+) | <img width="420" alt="Before: New Chat opens a read-only Claude chat with no input" src="https://github.com/user-attachments/assets/95fb61f3-8056-4dea-9c72-2170070116ae" /> | <img width="420" alt="After: New Chat opens a Local chat with a working input" src="https://github.com/user-attachments/assets/a7cc9460-7217-4e3f-ab18-50811a68d201" /> |
| Policy arrives with an unsent prompt | <img width="420" alt="Before: the draft becomes read-only and the prompt is lost" src="https://github.com/user-attachments/assets/162068e9-4657-4f7f-8cf7-42eb3a2511d0" /> | <img width="420" alt="After: a Local chat replaces the draft and keeps the prompt" src="https://github.com/user-attachments/assets/1665a0af-3164-4fed-b246-2c1c0bc03842" /> |

<details><summary>Codex, and full recordings</summary>

| Before | After |
|---|---|
| <img width="420" alt="Before: New Chat opens a read-only Codex chat" src="https://github.com/user-attachments/assets/43ce1a10-2ae3-4264-b518-b7e0e2fb663f" /> | <img width="420" alt="After: New Chat opens a Local chat" src="https://github.com/user-attachments/assets/8b03e6aa-99c0-4d52-a61a-0e79dfd59195" /> |
| [before.mp4](https://github.com/user-attachments/assets/dff68238-6882-4a12-a841-9b7db3f8800a) | [after.mp4](https://github.com/user-attachments/assets/307e7a7e-7aae-4b7c-8b08-b2dcc9dc3d6f) |

</details>

## Problem

If you had picked Claude and your organization then disabled it, **New Chat** (+), **New Chat Editor**, and new windows all opened an empty, read-only Claude chat:

> Your organization has disabled this agent. This conversation is read-only. Continue in Copilot to copy the conversation and keep the original.

The chat had no input, and **Continue in Copilot** did nothing because the chat was empty. Codex behaves the same when `chat.editor.codex.preferAgentHost` is on (likely https://github.com/microsoft/vscode/issues/344867).

## Repro

1. Pick **Claude** in the harness picker under the chat input.
2. Disable Claude by policy:
   ```jsonc
   // /etc/vscode/policy.json
   { "Claude3PIntegration": false }
   ```
3. Restart VS Code and click **New Chat** (+).

## What changes

- New chats skip a harness that policy disables and use the regular default: Local, or Copilot when policy requires the Agent Host.
- Your harness choice is remembered, so it comes back if the policy is lifted.
- A read-only empty chat saved before this fix is replaced on restore. If the policy arrives while you're typing, the new chat keeps your unsent prompt.
- Saved Claude chats with history stay readable, as before.

## Notes

- **Workaround until this ships:** for Codex, set `"chat.editor.codex.preferAgentHost": false`. For Claude, run **Chat: New Local Chat** (`workbench.action.chat.newLocalChat`), then pick **Local** or **Copilot** in the harness picker.
````

## Wording change across many surfaces

Rewritten from https://github.com/microsoft/vscode/pull/344670. Removed: the
16-item list of changed surfaces (one sentence now covers it), seven extra
screenshot pairs (now collapsed), and the `--grep` test command. The fact that
tests had not been run stayed, because a reviewer needs to know it.

````markdown
Related: https://github.com/microsoft/vscode/pull/343302

Restrictions that admins enforce now say **your organization** instead of **policy**, so users know who set the restriction and who to ask.

## Before / After

| Before | After |
|---|---|
| ![Before: Permissions picker says Disabled by policy](https://hediet-screenshots.azurewebsites.net/images/1bafa2fd6d2675333344cb4d4bd76918e0db8cfffc677db901d1fc4fee197ad7) | ![After: Permissions picker says Disabled by your organization](https://hediet-screenshots.azurewebsites.net/images/a024902cf9981d5f553b2444276b4e0fadea69a1db47d6ac059346eb34e7cdfd) |
| ![Before: Local harness disabled by policy](https://hediet-screenshots.azurewebsites.net/images/9d42979d6a094f39c4d50eee5daa0889e29b95f770350fcc88d4cba9c151fdc4) | ![After: Local harness disabled by your organization](https://hediet-screenshots.azurewebsites.net/images/7b8fb91c0bc8cdcb618c8edbd096766ff15c55ac8ec7c5be5597168151cfd2f0) |

<details><summary>More screenshots</summary>

| Before | After |
|---|---|
| ![Before: Agents window blocked by policy](https://hediet-screenshots.azurewebsites.net/images/622ce23edafa95d88c6e2ee779e41366bb9258500c8678bace20c0ca9f2509f5) | ![After: Agents window blocked by your organization](https://hediet-screenshots.azurewebsites.net/images/ff34c7ab84e98c6cba40b5d9305645d9f655fd242b6d7c2531ebe97cfb7c2bfa) |
| ![Before: MCP disabled by policy](https://hediet-screenshots.azurewebsites.net/images/e815579796a6bc9790f376208a30ffabf70c39b94b2b8d0369fe3dcffff4a68f) | ![After: MCP disabled by your organization](https://hediet-screenshots.azurewebsites.net/images/7f3cf52df0fca0a4ad9c86fd5b950f59ecb40eb01e59a8f51e74297738d5be1c) |

</details>

## What changes

| State | Before | After |
|---|---|---|
| Unavailable | Disabled by policy | **Disabled by your organization**. The hover says "Contact your administrator." |
| Set and locked | Managed by organization | **Managed by your organization** |
| Forced on | "…organization policy", "…via policy" | **Required by your organization** |

This applies to the Permissions and harness pickers, the Settings editor, MCP and plugin views, GitHub Environments, the sandbox toggle, and accessibility help. "Your organization" covers both org and enterprise policies, and most of the UI already used it.

## Notes

- Unit tests were not run in the authoring sandbox, because `npm ci` could not download native headers. The change touches only strings and test expectations.
- llama.cpp's "Blocked by policy" is unchanged, because the OS can cause it, not only the organization.
````

## Small change

A short body is fine for a small, obvious change. Don't add headings to it.
From https://github.com/microsoft/vscode/pull/340658:

````markdown
Similar to prompts, track changes to the Managed Settings Schema through each SDK roll in case new keys etc. come up with that need to be integrated.
````

## Bug report

Adapted from https://github.com/microsoft/vscode/issues/346310, which had the
screenshot at the bottom. It now comes first, then one line, steps, expected and
actual, and the build.

````markdown
<img width="800" alt="Send Positive Feedback is Inbox's only feedback control" src="https://github.com/user-attachments/assets/ca6e0931-1198-4c4d-bd81-3f7f68e953b1" />

Inbox's only feedback control is **Send Positive Feedback**, so there's no way to say Inbox isn't working for you.

**Steps**
1. Click **Inbox** in the Agents window sidebar.
2. Look at the top right of the toolbar, next to **Priority**, **Recent**, and the filter.
3. Click **Send Positive Feedback**, then close and reopen Inbox.

**Expected:** A neutral **Send Feedback** control with thumbs up and thumbs down, like chat responses.

**Actual:** Only **Send Positive Feedback**. After one click it becomes a disabled **Feedback Sent**; after reopening Inbox it's back, so positive feedback can be sent on every visit while negative feedback can't be sent at all.

**Build:** VS Code Insiders 1.146.0-insider (`69176e5c7703e4ddf6b91a8ad5daf4597c9bea29`), Linux, with `"chat.agentSessions.inbox.enabled": true`.
````
