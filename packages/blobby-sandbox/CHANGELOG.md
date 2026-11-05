# Changelog

Notable changes to `@rwoll/blobby-sandbox`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/); before 1.0, a minor version can break
things.

## [Unreleased]

## [0.1.0] - 2026-11-05

### Added

- Disposable sandboxes on Docker, smolvm, and Azure Container Apps, with recipes
  for a desktop that agents can drive and VS Code Insiders signed in to an
  allowlisted account, and the `blobby-sandbox` command.
- `blobby-sandbox image build` builds the optional `blobby-desktop` Docker image
  locally, on demand, from build files the package ships. No image is published.

[0.1.0]: https://github.com/rwoll/mono-oss/releases/tag/blobby-sandbox@0.1.0
