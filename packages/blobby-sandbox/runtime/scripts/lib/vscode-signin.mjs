// vscode-signin: signs the desktop's VS Code Insiders in to a GitHub test account. Run it with the
// account's secret: `blobby-sandbox exec <name> --secret github -- vscode-signin`. It runs as the desktop
// user, in the desktop's session, and asks the blobby-sandbox client for the login, the password, and a
// current 2FA code only when it needs each. The password and code come sealed to this process; the
// account's 2FA key never leaves the client.
//
// 1. Signs in to github.com in a throwaway headless Chrome.
// 2. Starts VS Code Insiders under Playwright and clicks through its real GitHub sign-in. VS Code's
//    request to open a browser goes to that signed-in Chrome, so the OAuth flow, including its
//    callback to VS Code, stays inside the desktop. No token is injected.
// 3. Quits VS Code, which saves the session in its profile, discards the browser, and opens VS Code
//    again, signed in, for the person or agent using the desktop.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import playwright from 'playwright-core'
import { done, progress, run, secret, secretName } from '../../lib/blobby.mjs'

const VSCODE = '/usr/share/code-insiders/code-insiders'
const CHROME = '/opt/google/chrome/chrome'
// The runtime's boot.sh writes this on machines that can't run Chromium's sandbox, such as Docker containers.
const NO_SANDBOX = existsSync('/etc/blobby/no-chromium-sandbox')
// The recipe's entry, which starts VS Code through the wrapper that adds --no-sandbox where it's needed.
const ENTRY = ['/usr/local/share/applications', '/usr/share/applications'].map((dir) => `${dir}/com.microsoft.VSCodeInsiders.desktop`).find((path) => existsSync(path))

function running(name) {
  try {
    execFileSync('pgrep', ['-u', String(process.getuid()), '-x', name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Quits VS Code if it runs, so this can start it under its control. VS Code keeps unsaved editors in backups. */
async function quitVSCode() {
  if (!running('code-insiders')) return
  progress('Quitting VS Code Insiders, to start it for signing in')
  const signal = (name) => {
    try {
      execFileSync('pkill', [`-${name}`, '-u', String(process.getuid()), '-x', 'code-insiders'], { stdio: 'ignore' })
    } catch {
      // Nothing left to signal.
    }
  }
  signal('TERM')
  for (let waited = 0; waited < 10_000 && running('code-insiders'); waited += 250) await sleep(250)
  if (running('code-insiders')) {
    signal('KILL')
    await sleep(500)
  }
}

/** Resolves with the name of the first outcome whose promise resolves. */
async function first(outcomes, timeout, what) {
  const entries = Object.entries(outcomes)
  const winner = await Promise.race([
    ...entries.map(([name, promise]) => promise.then(() => name, () => new Promise(() => {}))),
    sleep(timeout).then(() => null),
  ])
  if (!winner) throw new Error(`Timed out waiting ${what}`)
  return winner
}

/** Where the page is and what GitHub says there, for error messages. */
async function describe(page) {
  const path = new URL(page.url()).pathname
  const flash = await page.locator('.flash-error, .flash-warn, [role=alert]').first().innerText({ timeout: 1_000 }).catch(() => '')
  const heading = await page.locator('h1, h2').first().innerText({ timeout: 1_000 }).catch(() => '')
  return `${path}${heading ? `, "${heading.trim()}"` : ''}${flash ? `: ${flash.trim().replace(/\s+/g, ' ')}` : ''}`
}

const signedInAs = async (page) => (await page.locator('meta[name="user-login"]').getAttribute('content').catch(() => null)) || null

async function signInToGitHub(page, username) {
  await page.goto('https://github.com/login')
  if ((await signedInAs(page)) === username) {
    progress('Chrome is already signed in to the GitHub test account')
    return
  }
  progress('Signing in to the GitHub test account')
  await page.getByLabel('Username or email address').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(await secret('password'))
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const otp = page.locator('input[name="app_otp"]')
  const outcome = await first(
    {
      otp: otp.waitFor({ state: 'visible' }),
      wrongPassword: page.getByText('Incorrect username or password.').waitFor({ state: 'visible' }),
      deviceCheck: page.waitForURL((url) => url.pathname.startsWith('/sessions/verified-device')),
      signedIn: page.waitForURL((url) => !/^\/(?:login|sessions)(?:\/|$)/.test(url.pathname)),
    },
    30_000,
    'for GitHub to ask for the 2FA code',
  )
  if (outcome === 'wrongPassword') throw new Error(`GitHub says the username or password is wrong. Check the ${secretName()} secret: \`blobby-sandbox secrets\`.`)
  if (outcome === 'deviceCheck') throw new Error('GitHub asked to verify this device by email, which means the account has no TOTP 2FA. Set up an authenticator app for it.')
  if (outcome === 'signedIn') throw new Error('GitHub signed in without asking for a 2FA code. Set up an authenticator app for the test account.')
  // The client waits for a code GitHub has not seen yet, so ask only now that GitHub wants one.
  await otp.fill(await secret('otp'))
  const finished = await page
    .waitForURL((url) => !/^\/(?:login|sessions)(?:\/|$)/.test(url.pathname), { timeout: 30_000 })
    .then(() => true, () => false)
  if (!finished) throw new Error(`GitHub did not finish signing in after the 2FA code. It shows ${await describe(page)}`)
  await page.goto('https://github.com/settings/profile')
  const login = await signedInAs(page)
  if (login !== username) throw new Error(login ? `GitHub signed in to another account than the ${secretName()} secret's` : 'GitHub did not sign in')
  progress('Signed in to GitHub')
}

/** Whether the Accounts menu lists the account. Leaves the menu closed. */
async function showsAccount(window, username) {
  const accounts = window.getByRole('button', { name: 'Accounts', exact: true }).first()
  if (!(await accounts.isVisible().catch(() => false))) return false
  await accounts.click()
  const item = window.getByRole('menuitem', { name: new RegExp(username) }).first()
  const found = await item.waitFor({ state: 'visible', timeout: 1_500 }).then(() => true, () => false)
  await window.keyboard.press('Escape')
  return found
}

/** Waits until VS Code shows either a way to sign in or the signed-in account, so running this again is safe. */
async function signedIn(window, username) {
  const ways = window.getByRole('button', { name: /^(Sign In|Continue with GitHub)$/ }).first()
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(1_000)) {
    if (await ways.isVisible().catch(() => false)) return false
    if (await showsAccount(window, username)) return true
  }
  throw new Error('VS Code showed neither a way to sign in nor the account')
}

/** VS Code's GitHub sign-in starts from the welcome dialog of a new profile, or from the title bar's Sign In. */
async function startVSCodeSignIn(window) {
  const signIn = window.getByRole('button', { name: 'Sign In', exact: true }).first()
  const github = window.getByRole('button', { name: 'Continue with GitHub', exact: true }).first()
  await signIn.or(github).first().waitFor({ state: 'visible', timeout: 90_000 })
  const welcome = await github.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
  if (!welcome) await signIn.click()
  await github.click({ timeout: 30_000 })
  return welcome ? 'welcome dialog' : 'Sign In button'
}

/** Only VS Code's own loopback server and github.com may receive the browser. */
function checkSignInUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('VS Code asked to open something that is not a URL')
  }
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  const github = parsed.protocol === 'https:' && parsed.hostname === 'github.com'
  if (!loopback && !github) throw new Error(`VS Code asked to open ${parsed.origin}, not its sign-in server or github.com`)
}

/**
 * GitHub's one-time check of recently configured 2FA, which it may show instead of the authorization page.
 * Verifying it with a new code, instead of skipping it, keeps it from coming back the next day.
 */
async function passTwoFactorCheckup(page) {
  progress("GitHub asked to verify the test account's 2FA settings once; verifying them with a new code")
  await page.getByRole('button', { name: 'Verify 2FA now', exact: true }).click()
  const otp = page.locator('input[name="app_otp"]')
  await otp.waitFor({ state: 'visible', timeout: 30_000 })
  await otp.fill(await secret('otp'))
  // GitHub may submit the form by itself once the code is complete.
  await page.getByRole('button', { name: 'Verify', exact: true }).click({ timeout: 5_000 }).catch(() => {})
  // GitHub either moves on or stays and says so.
  const verified = await first(
    {
      left: page.waitForURL((url) => url.pathname !== '/settings/two_factor_checkup'),
      said: page.getByRole('heading', { name: /2FA verification successful/i }).waitFor({ state: 'visible' }),
    },
    30_000,
    'for GitHub to accept the code',
  ).then(() => true, () => false)
  if (!verified) throw new Error(`GitHub did not accept the code for its 2FA check. It shows ${await describe(page)}`)
  progress("Verified the test account's 2FA settings on GitHub")
}

async function authorizeInBrowser(page, url, username) {
  const account = page.getByRole('button', { name: new RegExp(username) })
  const authorize = page.getByRole('button', { name: /^Authorize Visual[ -]Studio[ -]Code(?: - Insiders)?$/i })
  const checkup = page.getByRole('button', { name: 'Verify 2FA now', exact: true })
  const shown = async () => {
    try {
      return await first(
        { account: account.waitFor({ state: 'visible' }), authorize: authorize.waitFor({ state: 'visible' }), checkup: checkup.waitFor({ state: 'visible' }) },
        30_000,
        'for GitHub to ask to authorize VS Code',
      )
    } catch (error) {
      throw new Error(`${error.message}. It shows ${await describe(page)}`)
    }
  }
  await page.goto(url)
  if ((await shown()) === 'checkup') {
    await passTwoFactorCheckup(page)
    await page.goto(url)
    if ((await shown()) === 'checkup') throw new Error('GitHub asked to verify the 2FA settings again')
  }
  if (await account.isVisible()) await account.click()
  // GitHub asks for consent the first time, then redirects back to VS Code's loopback server.
  try {
    await authorize.waitFor({ state: 'visible', timeout: 10_000 })
    await authorize.click()
  } catch {
    // Already authorized.
  }
}

/** Open the Accounts menu and look for the account, then close the menu. */
async function confirmSignedIn(window, username) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await window.keyboard.press('Escape')
    const accounts = window.getByRole('button', { name: 'Accounts', exact: true }).first()
    if (await accounts.isVisible()) {
      await accounts.click()
      const item = window.getByRole('menuitem', { name: new RegExp(username) }).first()
      const found = await item.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false)
      await window.keyboard.press('Escape')
      if (found) return
    }
    await sleep(2_000)
  }
  throw new Error('VS Code did not show the test account in its Accounts menu')
}

/** Signs VS Code in, unless it is already. `githubPage` signs a browser in to GitHub, only when it is needed. */
async function signInToVSCode(githubPage, username) {
  progress('Starting VS Code Insiders')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await playwright._electron.launch({ executablePath: VSCODE, args: [...(NO_SANDBOX ? ['--no-sandbox'] : []), '--skip-release-notes'], env, timeout: 90_000 })
  try {
    const urls = await app.evaluateHandle(() => [])
    await app.evaluate(({ shell }, queue) => {
      shell.openExternal = async (url) => {
        queue.push(url)
      }
    }, urls)
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    if (await signedIn(window, username)) {
      progress('VS Code is already signed in to the test account')
      return
    }
    const page = await githubPage()
    progress(`Started VS Code's GitHub sign-in from the ${await startVSCodeSignIn(window)}`)
    let url
    for (let waited = 0; !url && waited < 60_000; waited += 500) {
      url = await urls.evaluate((queue) => queue.shift())
      if (!url) await sleep(500)
    }
    if (!url) throw new Error('VS Code did not open the GitHub sign-in page')
    checkSignInUrl(url)
    await authorizeInBrowser(page, url, username)
    progress('Authorized VS Code on GitHub')
    await confirmSignedIn(window, username)
    progress('VS Code is signed in to the test account')
  } finally {
    // Quitting lets VS Code save the session to its profile.
    await app.close().catch(() => {})
  }
}

const USAGE = `Usage: blobby-sandbox exec <name> --secret <secret> -- vscode-signin

Signs VS Code Insiders in to the GitHub account of <secret>, such as github, and opens it. It is safe to
run again: an account that is already signed in is kept. The account's login must be in allowedLogins.`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}

run(async () => {
  if (!existsSync(VSCODE)) throw new Error('VS Code Insiders is not installed in this sandbox. Create one with `blobby-sandbox start <name> --recipe vscode-insiders`.')
  await quitVSCode()
  const username = await secret('login')
  // A throwaway browser signs in to GitHub and approves VS Code's sign-in; VS Code keeps the session.
  // Only a page that finished signing in is reused, so a second try never starts from a half-signed-in one.
  let browser
  let signedInPage
  const githubPage = async () => {
    if (signedInPage) return signedInPage
    browser ??= await playwright.chromium.launch({ executablePath: CHROME, headless: true })
    const page = await (await browser.newContext()).newPage()
    await signInToGitHub(page, username)
    signedInPage = page
    return page
  }
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await signInToVSCode(githubPage, username)
        break
      } catch (error) {
        const message = String(error?.message ?? error)
        // A fresh VS Code or GitHub page sometimes reloads while Playwright is reading it; a second try gets past it.
        if (attempt >= 2 || !/Execution context was destroyed|Target page, context or browser has been closed|Target closed|frame was detached/i.test(message)) throw error
        progress(`Signing in was interrupted by a page reloading (${message.split('\n')[0]}); trying once more`)
        await quitVSCode()
      }
    }
  } finally {
    await browser?.close().catch(() => {})
  }
  // In its own session, so it outlives this command, which blobby-sandbox stops when it ends.
  spawn('gio', ['launch', ENTRY], { detached: true, stdio: 'ignore' }).unref()
  progress('Opened VS Code Insiders')
  done({ [secretName()]: username })
})
