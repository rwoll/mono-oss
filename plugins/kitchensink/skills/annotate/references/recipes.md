# Recipes

## An annotated screenshot with Playwright

Measure marks from locators, so they line up at any device pixel ratio:

```ts
import { screenshotDocument } from '@rwoll/annotate/playwright'

const { documentPath } = await screenshotDocument(page, {
  path: 'out/settings.png',
  annotations: [
    { id: 'save', type: 'rect', locator: page.getByRole('button', { name: 'Save' }), tone: 'problem', label: 'Misaligned' },
    { type: 'redact', locator: page.getByTestId('api-key') },
    { type: 'arrow', from: [200, 120], to: 'save' },
  ],
})
// Then: annotate render out/settings.annotate.json -o out/settings-annotated.png
```

`boxOf(page, locator)` returns one box, if you build the document yourself. Pass
`fullPage: true` to both for full-page screenshots.

## A walkthrough video with Playwright

Record input and captions while Playwright records the video. Create the recorder
right after the page opens, so its clock matches the video:

```ts
import { recorder } from '@rwoll/annotate/playwright'
import { writeFile } from 'node:fs/promises'

// recordVideo.size equal to the viewport: videos are CSS pixels, and a larger size only adds padding.
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: 'out', size: { width: 1280, height: 800 } } })
const page = await context.newPage()
const rec = recorder(page, { scale: 1 })   // video pixels per CSS pixel
await page.goto(url)
rec.narrate('Rename the profile')
await page.waitForTimeout(1200)            // let each caption be read before the action it describes
await rec.type(page.getByLabel('Display name'), 'Ada Lovelace', { delay: 60 })
rec.narrate('Save with ⌘S')
await page.waitForTimeout(1200)
await rec.press('ControlOrMeta+s')
const key = await rec.box(page.getByTestId('api-key'))   // video pixels, not boxOf()
const video = await page.video()?.path()
await context.close()
const doc = rec.document({ path: video })
doc.annotations.push({ type: 'redact', box: key })
await writeFile('out/walkthrough.annotate.json', JSON.stringify(doc, null, 2))
```

The document has auto zoom, click ripples, key chips, and the captions. Add marks
(such as a `rect` on the bug, measured with `rec.box()`, with a `time` window), run
`check` (it flags captions too fast to read), then render:

```sh
annotate render out/walkthrough.annotate.json -o out/walkthrough.mp4 --vtt out/walkthrough.vtt
```

## Before and after

```sh
annotate init after.png --before before.png -o change.annotate.json
```

Then add one zoom shot per change, a `rect` with `tone: "changed"` and `step: true`
on each, and a `compare.track` that sweeps once and parks at `0.5` during each
shot. The last frame, with every change numbered, is a good PNG for the
description:

```sh
annotate render change.annotate.json -o change.mp4 -o change.png
```

## Pull request and issue media

- Use MP4 for video (it plays inline where GIFs are heavy), and PNG for stills.
- Upload the files to the pull request or issue description, put them first,
  right under the summary, and put the Markdown transcript under the video:
  `annotate captions walkthrough.annotate.json --format md`.
- Check the rendered files for anything private before uploading, even with redaction.

## From code

```ts
import { parseDocument, checkDocument } from '@rwoll/annotate'
import { render } from '@rwoll/annotate/node'

const doc = parseDocument(json)
for (const issue of checkDocument(doc)) console.warn(issue.path, issue.message)
await render(doc, { out: 'shot.png', baseDir: 'out' })
```

`@rwoll/annotate/react` has `<AnnotatePlayer document src />` for an interactive
player in a web page.
