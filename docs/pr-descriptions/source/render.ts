// Renders logo.png, and hero-light.png and hero-dark.png, the pr-descriptions illustration, from the pages here, with the installed Chrome.
// Run from oss/ after `pnpm install`: node docs/pr-descriptions/source/render.ts
import { createRequire } from 'node:module'

// playwright-core is a dependency of @rwoll/blobby-sandbox, not of this folder.
const require = createRequire(new URL('../../../packages/blobby-sandbox/package.json', import.meta.url))
const { chromium } = require('playwright-core') as typeof import('playwright-core')

const pages = [
  { page: 'logo.html', out: 'logo.png', width: 512, height: 512, transparent: true },
  { page: 'hero.html#light', out: 'hero-light.png', width: 1920, height: 1080 },
  { page: 'hero.html#dark', out: 'hero-dark.png', width: 1920, height: 1080 },
]

const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const { page: name, out, width, height, transparent = false } of pages) {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(new URL(name, import.meta.url).href)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(300)
    const path = new URL(`../${out}`, import.meta.url)
    await page.screenshot({ path: path.pathname, omitBackground: transparent })
    await page.close()
    console.log(`Wrote docs/pr-descriptions/${out}.`)
  }
} finally {
  await browser.close()
}
