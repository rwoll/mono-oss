<img src="https://raw.githubusercontent.com/rwoll/mono-oss/main/docs/blobby-sandbox/logo.png" alt="Blobby Sandbox logo: Blobby, the VS Code chat pet, peeking out of a cardboard box" width="96" align="right">

# Blobby Sandbox canvas

Start, see, drive, screenshot, and record Blobby sandboxes in Copilot. Canvas ID and plugin name:
`blobby-sandbox`.

```sh
copilot plugin marketplace add rwoll/mono-oss#stable
copilot plugin install blobby-sandbox@rwoll
```

The canvas is a thin client over the `blobby-sandbox` CLI from
[`@rwoll/blobby-sandbox`](https://github.com/rwoll/mono-oss/tree/main/packages/blobby-sandbox), which must be installed: `blobby-sandbox` on PATH (the skill's
`scripts/install-tools.ts` installs it), or `BLOBBY_SANDBOX_CLI` set to its path. The canvas runs the CLI instead of bundling the library, because
backends such as smolvm load native code, and so the canvas picks the same backend as the CLI:
`BLOBBY_SANDBOX_BACKEND`, or the default that `blobby-sandbox doctor` reports. With
`BLOBBY_SANDBOX_SERVER` and `BLOBBY_SANDBOX_TOKEN` set, the CLI, and so the canvas, uses sandboxes on that
server, and the viewer connects through its relay.

- `canvas.ts`: state and actions. Starts and sign-ins run in the background, and `refresh` copies their
  progress into state.
- `cli.ts`: runs the CLI with `--json`.
- `App.tsx`, `App.css`, and `Screen.tsx`: the React UI, with a noVNC viewer that connects to the sandbox's
  desktop on 127.0.0.1, or through the server's relay.

From `oss/marketplace`:

```sh
pnpm dev     # every canvas in a browser; this one runs the real CLI
pnpm test    # unit tests, against a fake CLI here
pnpm build   # the whole marketplace in dist/marketplace
```

The `blobby-sandbox` plugin also ships the [`blobby-sandbox` skill](https://github.com/rwoll/mono-oss/blob/main/marketplace/skills/blobby-sandbox/SKILL.md);
`vite.config.ts` lists both.

The viewer uses [noVNC](https://github.com/novnc/noVNC), which is MPL-2.0 and ships its license in its
npm package. The built plugin bundles it unchanged.
