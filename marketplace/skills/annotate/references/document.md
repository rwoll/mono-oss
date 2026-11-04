# The annotate document

Validate a document with `annotate check doc.json`, and print the full
JSON Schema with `annotate schema`. Points are `[x, y]` and boxes are
`[x, y, width, height]`, in source pixels. Times are seconds.

```jsonc
{
  "version": 1,
  "source": { "path": "shot.png", "width": 2560, "height": 1600, "scale": 2 },
  "duration": 9,                      // optional: the timeline length
  "compare": { "before": { "path": "before.png" }, "track": [[0, 0], [2, 1]] },
  "events": [{ "t": 1.2, "type": "click", "at": [800, 300] }],
  "camera": [{ "type": "zoom", "time": [1, 4], "box": [700, 250, 300, 120] }],
  "annotations": [{ "id": "save", "type": "rect", "box": [740, 352, 136, 36], "tone": "problem", "label": "Misaligned" }],
  "narration": [{ "t": 0.5, "text": "The Save button sits 8 px inside the edge" }],
  "output": { "width": 1920, "fps": 30, "scale": 1 }
}
```

## source and compare

- `source`: `path` (relative to the document), `width` and `height` (filled in by
  `init`, or read from the file), `duration` for video, `scale` (device pixel ratio).
- `compare`: a before/after wipe. `before` is media like `source`, the same size.
  `track` is `[time, position]` keyframes: `0` shows only before, `1` only after,
  `0.5` splits the frame. Park the split on a change while zoomed in to compare it.

## Annotations

Every annotation can have `id` (for references), `time` (`[start, end]`; omit to show
it throughout), and `tone`.

| type | Fields | Notes |
| --- | --- | --- |
| `rect`, `ellipse` | `box`, `label?`, `step?` (`true` or a number), `target?` | `target` records how the box was found, such as a locator |
| `arrow` | `from`, `to` (points or ids), `label?`, `bend?` (-1 to 1) | Pointing at an id stops at that annotation's edge |
| `callout` | `at` (point or id), `text` | A note pill at a point |
| `step` | `at` (point or id), `n?` | A numbered badge; at an id, on its top-left corner |
| `guide` | `x` or `y`, `label?` | A full-length dashed line, such as a content edge |
| `measure` | `from`, `to` (points), `label?` | Labeled with the distance in source pixels |
| `spotlight` | `box`, `pad?` | Dims everything else |
| `magnify` | `box`, `into`, `label?` | Shows `box` enlarged at `into`, with connector lines |
| `redact` | `box`, `style?` (`fill` or `pixelate`) | Changes source pixels; never give it a `time` |
| `clicks` | | A ripple at each `click` event |
| `keys` | | A chip for each `key` event |

Steps with `step: true` are numbered in order of their start time.

## events

Recorded input, for `clicks`, `keys`, and auto zoom: `{ t, type, at?, end?, keys? }`
with `type` one of `click`, `key`, `type`, `scroll`. `end` closes a `type` or
`scroll` span; `keys` is a label such as `⌘S`.

## camera

- `{ "type": "zoom", "time": [start, end], "box": [...], "ease"?: 0.7 }`: zoom onto a
  box. It is padded and grown to the frame's shape, at most 4× zoom.
- `{ "type": "auto", "from"?: ["click", "type", "key"], "zoom"?: 2.2, "lead"?: 0.8, "hold"?: 1 }`:
  follow events with `at`. Events close together share one shot; far apart, the
  camera pans straight from one to the next.

Shots that overlap end where the next begins. The camera zooms about the point two
shots share, so the subject stays put.

## narration

`{ "t": start, "text": "...", "end"?: seconds }`. Without `end`, a caption lasts until
the next one, or its reading time plus a moment. The last one stays to the end.

## output

`width` (default: the source width, at most 1920 for video and 960 for GIF), `fps`
(default 30, 12 for GIF), and `scale` for the size of marks and text (default 1).

## Duration

`duration`, else the video's length, else the last moment anything happens: the
end of a time window, shot, caption, event, or wipe keyframe. A document with none
of these is a still: render it as an image.
