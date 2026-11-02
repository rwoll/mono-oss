# rwoll/mono-oss

Open source tools and `@rwoll` npm packages by [@rwoll](https://github.com/rwoll).

> [!NOTE]
> This repository is a read-only mirror. It is published from a private
> monorepo, so pull requests are turned off and every commit here is an
> automated export. Bug reports and ideas are welcome as issues.

## Packages

| Package | Description |
| --- | --- |
| [`@rwoll/hello`](packages/hello) | Example package: shows the layout every `@rwoll` package starts from. |

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
`hello@0.1.0`. See [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
