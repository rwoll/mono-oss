# rwoll/mono-oss

Open source tools and `@rwoll` npm packages by [@rwoll](https://github.com/rwoll).

> [!NOTE]
> This repository is a read-only mirror. It is published from a private
> monorepo, so pull requests are turned off and every commit here is an
> automated export. Bug reports and ideas are welcome as issues.

## Packages

| Package | Description |
| --- | --- |
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

## Plugin marketplace

Copilot plugins from this repository, published to its `stable` branch:

```sh
copilot plugin marketplace add rwoll/mono-oss#stable
copilot plugin install canvas-kit@rwoll
```

| Plugin | Description |
| --- | --- |
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
