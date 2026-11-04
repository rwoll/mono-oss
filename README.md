# rwoll/mono-oss

Open source tools and `@rwoll` npm packages by [@rwoll](https://github.com/rwoll).

> [!NOTE]
> This repository is a read-only mirror. It is published from a private
> monorepo, so pull requests are turned off and every commit here is an
> automated export. Bug reports and ideas are welcome as issues.

## Packages

| Package | Description |
| --- | --- |
| [`@rwoll/annotate`](packages/annotate) | Annotate screenshots and screen recordings from one JSON document: zoom, marks, captions, before/after, and redaction, rendered to PNG, MP4, or an interactive player. |
| [`@rwoll/canvas-kit`](packages/canvas-kit) | Build Copilot canvas extensions with TypeScript and React: typed state and actions, a secure local host, a Vite build, test helpers, and marketplace publishing. |
| [`@rwoll/create-canvas`](packages/create-canvas) | `npm create @rwoll/canvas`: start a canvas marketplace with canvas-kit. |
| [`@rwoll/hello`](packages/hello) | Example package: shows the layout every `@rwoll` package starts from. |

## canvas-kit

<img src="docs/canvas-kit/logo.png" alt="canvas-kit logo: a chat bubble opening a canvas panel with a checklist" width="96" align="right">

**Copilot canvases you can change, test, and share.** Build the release boards,
triage queues, and review tools that you and your agent work in together: state
and actions in TypeScript, UI in React, and canvas-kit handles the rest.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/canvas-kit/hero-dark.png">
  <img alt="A Copilot window where the chat opens canvases that render the agent's notes with a shared React component, next to the canvas's React code, a Playwright test passing in light, dark, and high-contrast, and git push publishing the canvases for a teammate to install." src="docs/canvas-kit/hero-light.png">
</picture>

```sh
npm create @rwoll/canvas my-canvases -- --repository me/my-canvases --canvas board
```

See the [canvas-kit guide](packages/canvas-kit#readme) for the API.

## annotate

<img src="docs/annotate/logo.png" alt="annotate logo: a screenshot with a numbered highlight and an arrow pointing at it" width="96" align="right">

**Screenshots and screen recordings that explain themselves.** Describe the marks
once, in JSON: numbered steps, zoom that follows the action, captions, a
before/after wipe, and redaction. Render it to PNG, MP4, or GIF, or review it with
your agent in a Copilot canvas.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/annotate/hero-dark.png">
  <img alt="annotate: screenshots and recordings that explain themselves. Three outputs: a settings page with numbered steps, a boxed bug, and a redacted API key; a recording zoomed onto a toast that says Saved 0 changes, with a caption; and a before/after split zoomed onto a realigned Save button. Below, the Playwright and CLI code that made them." src="docs/annotate/hero-light.png">
</picture>

```sh
npx @rwoll/annotate render bug.annotate.json -o bug.png
```

See the [annotate guide](packages/annotate#readme) for examples and the format.

## Plugin marketplace

Copilot plugins from this repository, published to its `stable` branch:

```sh
copilot plugin marketplace add rwoll/mono-oss#stable
copilot plugin install canvas-kit@rwoll
```

| Plugin | Description |
| --- | --- |
| [`annotate`](marketplace/canvases/annotate) | A canvas and skill for annotated screenshots and screen recordings. |
| [`canvas-kit`](marketplace/plugins/canvas-kit) | Skills for building, testing, and publishing canvases with canvas-kit. |
| [`pr-descriptions`](marketplace/plugins/pr-descriptions) | A skill for short, reader-first pull request titles and descriptions. |
| [`session-summary`](marketplace/canvases/session-summary) | A canvas with an executive summary of the chat that the agent keeps up to date. |

## Development

Requires Node.js 24 and pnpm (the version in `package.json`'s `packageManager`).

```sh
pnpm install
pnpm check   # build, typecheck, lint, and test every package
```

Dependencies come from the public npm registry. pnpm installs only versions
published at least 7 days ago (`@rwoll` packages excepted) and never runs
dependency install scripts; see [pnpm-workspace.yaml](pnpm-workspace.yaml).

## Releases

Each package is versioned and released on its own, with tags such as
`canvas-kit@0.3.0`, and the marketplace publishes on every push. See
[RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
