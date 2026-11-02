# Releasing

Every package in [packages/](packages) is versioned and released on its own.
Releases are published to npm from this repository by
[release.yml](.github/workflows/release.yml), with
[provenance](https://docs.npmjs.com/generating-provenance-statements), and
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
4. **publish** waits for approval of the `npm` environment, downloads the build
   job's artifact by ID, checks every tarball against the recorded hashes, and
   publishes with provenance. Nothing is installed or built in this job, and only
   it can request an npm token.
5. **tag** creates the `<folder>@<version>` tag and a GitHub release with the
   changelog section.

Versions already on npm are skipped, so rerunning a failed release (**Run
workflow** on Release) is safe. Prerelease versions such as `1.0.0-beta.1`
publish to the `next` dist-tag.

### canvas-kit and create-canvas

`npm create @rwoll/canvas` runs `canvas-kit init` from the `@rwoll/canvas-kit`
it depends on, so release `create-canvas` with each `canvas-kit` release that
changes `init` or its templates (bump both, then merge once).

While packing, the release writes `cli/release.json` into `@rwoll/canvas-kit`
with this repository's commit and the `canvas-kit@<version>` tag. `canvas-kit
init` pins new marketplaces' publish workflow to
`rwoll/mono-oss/.github/workflows/marketplace.yml` at that commit, so a later
change here never runs in their workflows until they update the pin.

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

npm trusted publishing can only be set up for a package name that exists, and
provenance needs a public repository. No npm token goes into GitHub: claim the
name once from your machine, then every release comes from CI.

1. Claim the name with a placeholder, with 2FA:

   ```sh
   mkdir /tmp/placeholder && cd /tmp/placeholder && npm init -y
   npm pkg set name=@rwoll/<name> version=0.0.0-placeholder
   npm publish --access public --tag placeholder --registry https://registry.npmjs.org/
   ```

2. On npmjs.com, in the package's settings:
   - **Trusted publishing**: GitHub Actions, repository `rwoll/mono-oss`,
     workflow `release.yml`, environment `npm`. Under **Allowed actions**, also
     allow `npm publish`.
   - **Publishing access**: "Require two-factor authentication and disallow
     tokens". Trusted publishing keeps working.

   A new trusted publisher must publish within 2 days or npm drops it, so add
   it when the release is ready.
3. Release the package as above.

## How releases are protected

| Setting | What it does |
| --- | --- |
| `npm` environment | Only `main` deploys, and a maintainer approves each release. The only place an npm token can be requested. |
| `stable` environment | Only `main` deploys; the only job that can push the `stable` branch. |
| Pull requests | Turned off: this repository only changes through the export. |
| Ruleset on `main` | Only the export's GitHub App can push; no force pushes or deletion. |
| Tags | Created only by the release workflow after a successful publish. |
| [`actions.lock`](.github/workflows/actions.lock) | Every action runs at the commit the lockfile records, checked again by the runner. |
| Dependencies | pnpm installs only versions published at least 7 days ago (`@rwoll` packages excepted), never runs dependency install scripts, and CI installs with the frozen lockfile. |

The export from the private monorepo is gated too: a secret scan and a denylist
must pass, and an AI review must pass or a maintainer must explicitly override
it, before anything is pushed here.
