// Renders logo.png from the page here, with the installed Chrome.
// Run from oss/ after `pnpm install`: node docs/copilot-spend/source/render.ts
// canvas-*.png and session-*.png are screenshots of the real canvas with invented sessions.
import { createRequire } from 'node:module'

// playwright-core is a dependency of @rwoll/blobby-sandbox, not of this folder.
const require = createRequire(new URL('../../../packages/blobby-sandbox/package.json', import.meta.url))
const { chromium } = require('playwright-core') as typeof import('playwright-core')

const pages = [{ page: 'logo.html', out: 'logo.png', width: 512, height: 512, transparent: true }]

const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const { page: name, out, width, height, transparent } of pages) {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(new URL(name, import.meta.url).href)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(300)
    await page.screenshot({ path: new URL(`../${out}`, import.meta.url).pathname, omitBackground: transparent })
    await page.close()
    console.log(`Wrote docs/copilot-spend/${out}.`)
  }
} finally {
  await browser.close()
}
