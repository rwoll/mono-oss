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
| [`canvas-kit`](plugins/canvas-kit) | Skills for building, testing, and publishing Copilot canvases with [`@rwoll/canvas-kit`](../packages/canvas-kit). |

Each folder in [plugins/](plugins) is a plugin with its own `plugin.json`.
Canvases built with canvas-kit go in `canvases/`, with a `vite.config.ts`, once
there are any. `pnpm build` assembles `dist/marketplace` with `canvas-kit build`.
