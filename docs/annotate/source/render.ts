// Renders logo.png from logo.html, with the installed Chrome.
// Run from oss/ after `pnpm install`: node docs/annotate/source/render.ts
import { createRequire } from 'node:module'

// playwright-core is a dependency of @rwoll/blobby-sandbox, not of this folder.
const require = createRequire(new URL('../../../packages/blobby-sandbox/package.json', import.meta.url))
const { chromium } = require('playwright-core') as typeof import('playwright-core')

const browser = await chromium.launch({ channel: 'chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
  await page.goto(new URL('logo.html', import.meta.url).href)
  await page.waitForTimeout(300)
  await page.screenshot({ path: new URL('../logo.png', import.meta.url).pathname, omitBackground: true })
  console.log('Wrote docs/annotate/logo.png.')
} finally {
  await browser.close()
}
