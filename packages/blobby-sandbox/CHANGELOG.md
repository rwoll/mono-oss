# Changelog

Notable changes to `@rwoll/blobby-sandbox`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/); before 1.0, a minor version can break
things.

## [Unreleased]

### Added

- Disposable sandboxes on Docker, smolvm, and Azure Container Apps, with recipes
  for a desktop that agents can drive and VS Code Insiders signed in to an
  allowlisted account, and the `blobby-sandbox` command. Not yet released.
- `blobby-sandbox image build` builds the optional `blobby-desktop` Docker image
  locally, on demand, from build files the package ships. No image is published.
