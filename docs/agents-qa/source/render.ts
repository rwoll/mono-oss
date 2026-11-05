// Renders logo.png, hero-light.png, and hero-dark.png from the pages here, with the installed Chrome.
// Run from oss/ after `pnpm install`: node docs/agents-qa/source/render.ts
// It first draws blobby-hard-hat-*.png: Blobby wearing VS Code's construction hard hat, the way its chat pet does.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// playwright-core is a dependency of @rwoll/blobby-sandbox, not of this folder.
const require = createRequire(new URL('../../../packages/blobby-sandbox/package.json', import.meta.url))
const { chromium } = require('playwright-core') as typeof import('playwright-core')

const pages = [
  { page: 'logo.html', out: 'logo.png', width: 512, height: 512, transparent: true },
  { page: 'hero.html#light', out: 'hero-light.png', width: 1920, height: 1080 },
  { page: 'hero.html#dark', out: 'hero-dark.png', width: 1920, height: 1080 },
]

const source = (file: string) => new URL(file, import.meta.url)
const dataUrl = (file: string) => `data:image/png;base64,${readFileSync(source(file)).toString('base64')}`

const browser = await chromium.launch({ channel: 'chrome' })
try {
  const canvas = await browser.newPage()
  for (const pose of ['idle', 'cool']) {
    const png = await canvas.evaluate(async ([bodyUrl, hatUrl]) => {
      const load = (src: string) => new Promise<HTMLImageElement>((done) => { const image = new Image(); image.onload = () => done(image); image.src = src })
      const [body, hat] = await Promise.all([load(bodyUrl!), load(hatUrl!)])
      const context = Object.assign(document.createElement('canvas'), { width: 96, height: 96 }).getContext('2d')!
      // Frame 0 of the upright pose: the hat's 96 px cells line up with the body at (0, 0).
      context.drawImage(body, 0, 0, 96, 96, 0, 0, 96, 96)
      context.clearRect(16, 0, 64, 32) // the hard hat covers the antennae
      context.globalCompositeOperation = 'destination-over'
      context.drawImage(hat, 0, 0, 96, 96, 0, 0, 96, 96) // back layer
      context.globalCompositeOperation = 'source-over'
      context.drawImage(hat, 0, 96, 96, 96, 0, 0, 96, 96) // front layer
      return context.canvas.toDataURL('image/png')
    }, [dataUrl(`buddy-${pose}-insiders-96.png`), dataUrl('construction-hard-hat.png')])
    writeFileSync(source(`blobby-hard-hat-${pose}-96.png`), Buffer.from(png.split(',')[1]!, 'base64'))
  }
  await canvas.close()
  for (const { page: name, out, width, height, transparent = false } of pages) {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(new URL(name, import.meta.url).href)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(300)
    const path = new URL(`../${out}`, import.meta.url)
    await page.screenshot({ path: path.pathname, omitBackground: transparent })
    await page.close()
    console.log(`Wrote docs/agents-qa/${out}.`)
  }
} finally {
  await browser.close()
}
