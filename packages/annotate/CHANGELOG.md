# Changelog

Notable changes to `@rwoll/annotate`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Lighter, easier-to-read marks: 2.5 px strokes with a thin white halo (were
  3 px strokes on a 6 px halo), 3 px corners, and thinner arrows, dimension
  lines, and step badges.
- Labels are small-radius chips with a soft shadow instead of round pills with a
  white border, and a box's label is a tab attached to its corner.
- Darker tone colors, with darker label fills than strokes, so white label text
  is readable on every tone. Adds `TONE_LABEL_COLORS` next to `TONE_COLORS`.

## [0.1.0] - 2026-11-04

### Added

- First version: the annotate document (marks, camera shots, input events,
  before/after, captions, and redaction) with its JSON Schema; rendering to PNG,
  JPEG, WebP, AVIF, MP4, WebM, and GIF with sharp and ffmpeg; the `annotate` CLI
  (`init`, `check`, `render`, `grid`, `convert`, `captions`, `schema`); a browser compositor and
  `<AnnotatePlayer>` for React; and Playwright helpers that anchor marks to
  locators (`boxOf` for screenshots, `recorder().box` for recordings) and record
  input alongside a video.

[0.1.0]: https://github.com/rwoll/mono-oss/releases/tag/annotate@0.1.0
