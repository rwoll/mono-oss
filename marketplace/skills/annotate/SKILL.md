---
name: annotate
description: "Make annotated screenshots and screen recordings that show a UI problem or change: boxes, arrows, numbered steps, zoom, magnifier, spotlight, measurements, before/after wipe, redaction, and captions, from one JSON document, rendered to PNG, MP4, or GIF with the `annotate` CLI (`@rwoll/annotate`), and reviewed with the user in the annotate canvas. Use it when you need to show, not tell: bug reports, pull request media, QA findings, walkthroughs, and visual diffs."
---

# Annotate screenshots and recordings

One JSON document describes everything drawn on an image or video. The same
document renders to a flat PNG or MP4 (`annotate render`) and plays in
the annotate canvas, where the user can fix a mark by dragging it. The CLI needs
Node.js 24; video needs ffmpeg.

**Setup.** Run `annotate --version`. If the command is missing, or the canvas says
it's too old, ask the user, then run `node scripts/install-tools.ts annotate` from
this skill's folder. It installs `@rwoll/annotate` globally from its newest GitHub
release, after checking the download against GitHub's digest; its other
dependencies come from npm's registry, only once they're 7 days old.
Don't run the CLI with npx.

Read [references/document.md](references/document.md) for every field and
[references/recipes.md](references/recipes.md) for Playwright capture, recordings,
before/after, and pull request media.

## Workflow

1. **Capture.** With Playwright, measure marks from locators instead of guessing
   pixels (`screenshotDocument` and `recorder` from `@rwoll/annotate/playwright`).
   For an existing image or video, start a document:

   ```sh
   annotate init shot.png          # writes shot.annotate.json with the size
   ```

2. **Find positions.** Coordinates are source pixels: the image's own pixels
   (CSS pixels × device pixel ratio for a screenshot). Without locators, draw a
   grid, look at it, and read positions off it:

   ```sh
   annotate grid shot.png -o grid.png --step 100
   ```

3. **Write the document**: annotations, and for video, camera shots and captions.
4. **Check it.** It catches unknown ids, marks outside the frame, captions too fast
   to read, and redactions that do not cover the whole video:

   ```sh
   annotate check shot.annotate.json
   ```

5. **Render, then look at the output** before you share it. Fix overlaps, wrong
   boxes, and unreadable labels, and render again.

   ```sh
   annotate render shot.annotate.json -o shot.png
   annotate render demo.annotate.json -o demo.mp4 -o demo.gif --vtt demo.vtt
   ```

6. **Review with the user** when the result matters: open the canvas (below). They
   can drag marks, edit labels and captions, export, and send you notes.

## Pick marks by what you need to say

| To say | Use |
| --- | --- |
| "This is broken" | `rect` or `ellipse` with `tone: "problem"` and a short `label` |
| "Here is why, in a sentence" | a `note` on the mark, shown in the notes panel ([below](#inline-labels-or-a-notes-panel)) |
| "Look here" | `arrow` to an annotation's `id`, `spotlight`, or a camera `zoom` |
| "Do these in order" | `rect` with `step: true` (numbered by time), or `step` badges |
| "This changed" | `compare` (before/after wipe) and `rect` with `tone: "changed"`, `"added"`, or `"removed"` |
| "It is off by N px" | `measure` and `guide` (an edge line) |
| "This is too small to see" | `magnify` (a lens with connector lines), or a `zoom` shot |
| "What was typed and clicked" | `clicks` and `keys` with recorded `events`, plus `camera: [{ "type": "auto" }]` |
| "Never show this" | `redact` (applied to source pixels before anything else) |

Tones color marks by meaning: `problem`, `warning`, `changed`, `added`, `removed`,
`note` (default), `success`, `accent`. Keep labels to a few words; put sentences in
captions or notes.

## Inline labels or a notes panel

Inline labels are the easiest to read: the words sit on the thing they describe.
Use them by default, for a few short points that are spread out.

Move the words to a notes panel (beside or below the image) when inline labels
would get in the way:

- They would cover something the reader needs to see, such as the text being
  reported or the controls around it.
- Several marks are close together, so their labels would crowd or overlap.
- A point needs a sentence or two, or `code`, to explain.

Give each such mark a `note` instead of (or with) its `label`. The mark gets a
number, and the panel lists the notes by number:

```json
{
  "notes": { "title": "Settings page review" },
  "annotations": [
    { "type": "rect", "box": [740, 352, 136, 36], "tone": "problem", "note": "**Save changes** ends 8 px short of the card edge; the others use `padding-right: 24px`." },
    { "type": "ellipse", "box": [836, 513, 40, 22], "tone": "warning", "note": "**Product updates** is on by default for new accounts." }
  ]
}
```

The panel goes below wide images, so they keep their width in a pull request, and
beside tall ones; set `"side": "right"` or `"bottom"` to choose. Mixing is fine: a
short `label` for a mark that has room, and notes for the rest. In a video, notes of
marks not shown yet are dimmed.

## Captions for silent videos

Recordings have no sound, so captions carry the story. Give each cue only a start
time `t`; its end defaults to the next cue or its reading time.

- One idea per caption, under about 60 characters, in plain words: "Turn on
  product updates", "The toast says 0 changes, but 2 changed".
- Start a caption just before the action it explains. `check` warns when one is
  shown for less than its reading time (about 15 characters a second).
- Captions are burned into MP4 and GIF by default. `--captions soft` adds a
  subtitle track instead (MP4, WebM), and `--vtt` writes a WebVTT file.
- For a pull request, put the transcript under the video:
  `annotate captions demo.annotate.json --format md`.

## Redaction

Redact secrets, tokens, personal data, and anything private before sharing.
`redact` changes source pixels before the camera, lenses, or export see them, so the
secret never reaches an output. Use the default `fill`; `pixelate` keeps the layout
readable but can leak short text. Never give a redaction a `time` window. The
original screenshot or recording still contains the secret, so share only the
rendered output.

## The annotate canvas

Open it for the user with a document, or with an image or video to start one:
`open_canvas` with canvas `rwoll-annotate` and input `{ "path": "/abs/path/shot.annotate.json" }`.
The file is the source of truth: the canvas saves every edit to it and reloads it
within two seconds when you edit it directly. Its actions:

| Action | Input |
| --- | --- |
| `add_annotations` | `{ annotations: [...] }`; returns the new ids |
| `update_annotation` | `{ target: id or index, changes: {...} }`; `null` removes a field |
| `remove_annotations` | `{ targets: [id or index, ...] }` |
| `set_narration`, `set_camera` | `{ narration: [...] }`, `{ camera: [...] }` |
| `set_document` | `{ document }` to replace everything |
| `seek` | `{ time }` to show the user a moment |
| `export` | `{ format: "png" \| "jpg" \| "webp" \| "mp4" \| "webm" \| "gif", at?, out?, captions? }`; returns the path |
| `reload` | re-read the file |

When the user exports or sends a note from the canvas, you get a message with the
path or their note (and the annotation they selected). Act on it with the actions
above.

## Pitfalls

- **Pixels.** A 1280×800 viewport at device pixel ratio 2 is a 2560×1600
  screenshot; boxes are in those pixels. `boxOf` and `screenshotDocument` handle it.
- **Recordings are in CSS pixels.** Playwright records the viewport at 1 video pixel
  per CSS pixel whatever the device pixel ratio, scaled to fit 800×800 unless
  `recordVideo.size` is set. Set the size to the viewport (larger is padded with
  gray, not sharper), pass the scale to `recorder`, and measure marks on the video
  with `rec.box()`, never `boxOf()`. A redaction measured in the wrong pixels misses
  the secret: check a few rendered frames.
- **Look before you share.** Render, view the image or a few video frames, and fix
  what you see. Labels avoid each other, but not everything.
- **ffmpeg.** Video input and output need it on PATH (or `--ffmpeg`, or
  `ANNOTATE_FFMPEG`). Stills do not.
