// Renders logo.png (kitchensink) and logo-locked.png (kitchensink-private) from logo.html, with the installed Chrome.
// Run from oss/ after `pnpm install`: node docs/marketplace/source/render.ts
import { createRequire } from 'node:module'

// playwright-core is a dependency of @rwoll/blobby-sandbox, not of this folder.
const require = createRequire(new URL('../../../packages/blobby-sandbox/package.json', import.meta.url))
const { chromium } = require('playwright-core') as typeof import('playwright-core')

const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const { hash, out } of [{ hash: '', out: 'logo.png' }, { hash: '#locked', out: 'logo-locked.png' }]) {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
    await page.goto(new URL(`logo.html${hash}`, import.meta.url).href)
    await page.waitForTimeout(300)
    await page.screenshot({ path: new URL(`../${out}`, import.meta.url).pathname, omitBackground: true })
    await page.close()
    console.log(`Wrote docs/marketplace/${out}.`)
  }
} finally {
  await browser.close()
}
