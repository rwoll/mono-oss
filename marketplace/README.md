# The rwoll plugin marketplace

Copilot plugins published to the `stable` branch of this repository by
[Publish marketplace](../.github/workflows/publish-marketplace.yml) on every push
to `main`. Install:

```sh
copilot plugin marketplace add rwoll/mono-oss#stable
copilot plugin install canvas-kit@rwoll
```

| Plugin | What it is |
| --- | --- |
| [`annotate`](canvases/annotate) | A canvas and skill for annotated screenshots and screen recordings, made with [`@rwoll/annotate`](../packages/annotate). |
| [`canvas-kit`](plugins/canvas-kit) | Skills for building, testing, and publishing Copilot canvases with [`@rwoll/canvas-kit`](../packages/canvas-kit). |
| [`pr-descriptions`](plugins/pr-descriptions) | A skill for short, reader-first pull request titles and descriptions. |
| [`session-summary`](canvases/session-summary) | A canvas with an executive summary of the chat that the agent keeps up to date. |

Each folder in [plugins/](plugins) is a content plugin (skills, MCP servers)
with its own `plugin.json`. Each folder in [canvases/](canvases) is a canvas built
with canvas-kit; [vite.config.ts](vite.config.ts) lists which plugin ships it.
Canvases share the React components and theme in [ui/](ui). `pnpm build` builds
the canvases and assembles `dist/marketplace` with `canvas-kit build`; `pnpm e2e`
runs the canvases' browser tests.
