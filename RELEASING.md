# Releasing

Every package in [packages/](packages) is versioned and released on its own.
Releases are published to npm from this repository by
[release.yml](.github/workflows/release.yml) with npm trusted publishing, and
tagged `<folder>@<version>` (for example `hello@0.1.0`).

## Release a package

This repository is an export of a private monorepo, where all development
happens. There:

```sh
pnpm release hello minor   # or patch, major, or an exact version like 1.0.0-beta.1
git commit -am "Release hello@0.1.0"
```

`pnpm release` bumps the version and turns `## [Unreleased]` in the package's
CHANGELOG.md into the new version's section. After it is merged and exported
here, [Release](.github/workflows/release.yml) runs on the push to `main`:

1. **plan** lists every package that is not `private`, whose version is not
   `0.0.0` (never released), and whose version is not on npm yet.
2. **build** installs with the frozen lockfile, builds, and packs those packages,
   and records each tarball's hash.
3. **test** runs `pnpm check`.
4. **publish** runs in the `npm` environment (`main` only), downloads the build
   job's artifact by ID, checks every tarball against the recorded hashes, and
   [stages](https://docs.npmjs.com/cli/v12/commands/npm-stage) them with
   `npm stage publish`. npm adds
   [provenance](https://docs.npmjs.com/generating-provenance-statements) only when
   this repository is public. Nothing is installed or built in this job, and only
   it can request an npm token.
5. **tag** creates the `<folder>@<version>` tag and a GitHub release with the
   changelog section and the package's [GitHub tarball](#github-release-tarballs),
   checked against the hash the build job recorded.
6. **You approve** each staged version with 2FA, on the package's page on
   npmjs.com or from your machine. Until then nobody can install it:

   ```sh
   npm stage list @rwoll/canvas-kit
   npm stage approve <stage-id>
   ```

Versions already on npm are skipped. A version that is staged but not approved
cannot be staged again, so approve or reject it (`npm stage reject <stage-id>`)
before rerunning a failed release (**Run workflow** on Release). Prerelease
versions such as `1.0.0-beta.1` publish to the `next` dist-tag.

### canvas-kit and create-canvas

`npm create @rwoll/canvas` runs `canvas-kit init` from the `@rwoll/canvas-kit`
it depends on, so release `create-canvas` with each `canvas-kit` release that
changes `init` or its templates (bump both, then merge once).

While packing, the release writes `release.json` into `@rwoll/canvas-kit`
with this repository's commit and the `canvas-kit@<version>` tag. `canvas-kit
init` pins new marketplaces' publish workflow to
`rwoll/mono-oss/.github/workflows/marketplace.yml` at that commit, so a later
change here never runs in their workflows until they update the pin.

## GitHub release tarballs

Some machines can't reach registry.npmjs.org. So each release also carries a
tarball that installs without it:

```sh
npm install -g https://github.com/rwoll/mono-oss/releases/download/canvas-kit%400.3.0/rwoll-canvas-kit-0.3.0.tgz
```

It is the npm tarball, except that dependencies on other `@rwoll` packages point
at their release tarballs instead of version ranges (a package without any is
attached unchanged). Every other dependency still comes from npm's configured
registry, such as a company mirror. For example, `@rwoll/create-canvas`:

| Tarball | `@rwoll/canvas-kit` dependency |
| --- | --- |
| On npm | `^0.3.0` |
| On the release | `https://github.com/rwoll/mono-oss/releases/download/canvas-kit%400.3.0/rwoll-canvas-kit-0.3.0.tgz` |

The build job makes them with the npm tarballs
([release-tarballs.ts](scripts/release-tarballs.ts)) and refuses to point at a
release without its tarball. Releases are immutable, so a tarball can't change
once its release is created, and GitHub shows each one's SHA-256 digest.
**backfill**, which runs after every release, attaches tarballs made from the
packages on npm to earlier releases that have none.

## Publish the marketplace

[Publish marketplace](.github/workflows/publish-marketplace.yml) runs on every
push to `main` and calls the same reusable
[marketplace.yml](.github/workflows/marketplace.yml) that canvas-kit users pin:

1. **build** (read-only token) installs with the frozen lockfile, runs
   `marketplace/`'s `check` script in a clean worktree, and prepares the next
   `stable` commit as a git bundle, only when the output changed.
2. **push** runs in the `stable` environment (`main` only), checks the bundle
   without running anything from it, and fast-forwards `stable`.

Each plugin gets a `release.json` stamp with the source commit that last changed it.

## First publish of a new package

npm trusted publishing can only be set up for a package name that exists. No npm token goes into GitHub: claim the
name once from your machine, then every release comes from CI.

1. Claim the name with a placeholder, with 2FA:

   ```sh
   mkdir /tmp/placeholder && cd /tmp/placeholder && npm init -y
   npm pkg set name=@rwoll/<name> version=0.0.0-placeholder
   npm publish --access public --tag placeholder --registry https://registry.npmjs.org/
   ```

2. On npmjs.com, in the package's settings:
   - **Trusted publishing**: GitHub Actions, repository `rwoll/mono-oss`,
     workflow `release.yml`, environment `npm`. Under **Allowed actions**, allow
     only `npm stage publish`, so every release waits for your approval.
   - **Publishing access**: "Require two-factor authentication and disallow
     tokens". Trusted publishing keeps working.

   A new trusted publisher must publish within 2 days or npm expires it, so add
   it when the release is ready.
3. Release the package as above.

## How releases are protected

| Setting | What it does |
| --- | --- |
| `npm` environment | Only `main` deploys. The only place an npm token can be requested. |
| Staged publishing | Trusted publishing may only stage; a maintainer approves each version on npm with 2FA before it is public. Tokens cannot publish. |
| `stable` environment | Only `main` deploys; the only job that can push the `stable` branch. |
| Pull requests | Turned off: this repository only changes through the export. |
| Ruleset on `main` | Only the export's GitHub App can push; no force pushes or deletion. |
| Tags | Created only by the release workflow after the packages are staged. |
| Immutable releases | A release's tarball can't be replaced or removed once the release is created. |
| [`actions.lock`](.github/workflows/actions.lock) | Every action runs at the commit the lockfile records, checked again by the runner. |
| Dependencies | pnpm installs only versions published at least 7 days ago (`@rwoll` packages excepted), never runs dependency install scripts, and CI installs with the frozen lockfile. |

The export from the private monorepo is gated too: a secret scan and a denylist
must pass, and an AI review must pass or a maintainer must explicitly override
it, before anything is pushed here.
