<img src="https://raw.githubusercontent.com/rwoll/mono-oss/main/docs/marketplace/logo.png" alt="kitchensink plugin logo: Blobby, the VS Code chat pet, sitting in a kitchen sink" width="96" align="right">

# The rwoll plugin marketplace

One Copilot plugin, `kitchensink`, with everything but the kitchen sink, published to
the `stable` branch of this repository by
[Publish marketplace](https://github.com/rwoll/mono-oss/blob/main/.github/workflows/publish-marketplace.yml)
on every push to `main`. Install:

[![Install kitchensink in VS Code](https://img.shields.io/badge/VS_Code-Install_kitchensink-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3A%2F%2Fchat-plugin%2Finstall%3Fsource%3DcndvbGwvbW9uby1vc3Mjc3RhYmxl%26plugin%3Dkitchensink)
[![Install kitchensink in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_kitchensink-24bfa5?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode-insiders%3A%2F%2Fchat-plugin%2Finstall%3Fsource%3DcndvbGwvbW9uby1vc3Mjc3RhYmxl%26plugin%3Dkitchensink)

```sh
copilot plugin marketplace add rwoll/mono-oss#stable
copilot plugin install kitchensink@rwoll
```

| Part | What it is |
| --- | --- |
| [`annotate`](https://github.com/rwoll/mono-oss/tree/main/marketplace/canvases/annotate) | A canvas and skill for annotated screenshots and screen recordings, made with [`@rwoll/annotate`](https://github.com/rwoll/mono-oss/tree/main/packages/annotate). |
| [`blobby-sandbox`](https://github.com/rwoll/mono-oss/tree/main/marketplace/canvases/blobby-sandbox) | A canvas and skill to start, watch, and drive disposable desktops with [`@rwoll/blobby-sandbox`](https://github.com/rwoll/mono-oss/tree/main/packages/blobby-sandbox). |
| [`canvas-kit`](https://github.com/rwoll/mono-oss/blob/main/marketplace/skills/canvas-kit/SKILL.md), [`canvas-kit-testing`](https://github.com/rwoll/mono-oss/blob/main/marketplace/skills/canvas-kit-testing/SKILL.md), [`canvas-kit-publishing`](https://github.com/rwoll/mono-oss/blob/main/marketplace/skills/canvas-kit-publishing/SKILL.md) | Skills for building, testing, and publishing Copilot canvases with [`@rwoll/canvas-kit`](https://github.com/rwoll/mono-oss/tree/main/packages/canvas-kit). |
| [`pr-descriptions`](https://github.com/rwoll/mono-oss/blob/main/marketplace/skills/pr-descriptions/SKILL.md) | A skill for short, media-first pull request and bug report descriptions. |
| [`agents-qa`](https://github.com/rwoll/mono-oss/tree/main/marketplace/canvases/agents-qa) | Scheduled QA runs of the VS Code Agents window in a Blobby sandbox (a skill), and a canvas to triage what they find. |
| [`session-summary`](https://github.com/rwoll/mono-oss/tree/main/marketplace/canvases/session-summary) | A canvas with an executive summary of the chat that the agent keeps up to date. |

Skills live in [skills/](https://github.com/rwoll/mono-oss/tree/main/marketplace/skills)
and canvases in [canvases/](https://github.com/rwoll/mono-oss/tree/main/marketplace/canvases),
built with canvas-kit;
[vite.config.ts](https://github.com/rwoll/mono-oss/blob/main/marketplace/vite.config.ts)
puts them all in the `kitchensink` plugin. Canvases share the React components and theme
in [ui/](https://github.com/rwoll/mono-oss/tree/main/marketplace/ui). `pnpm build`
builds the canvases and assembles `dist/marketplace` with `canvas-kit build`;
`pnpm e2e` runs the canvases' browser tests.
