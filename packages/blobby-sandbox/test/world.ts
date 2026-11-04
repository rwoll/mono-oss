import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Capabilities } from '../src/backend.ts'
import { FakeBackend } from '../src/fake.ts'
import { recipeRef, resolveRecipe, type Recipe, type RecipeRef } from '../src/recipe.ts'
import { Sandboxes } from '../src/sandboxes.ts'
import { Secrets } from '../src/secrets.ts'
import { fakeGuest, guestState, type GuestState } from './fake-guest.ts'
import { RFC_KEY } from './rfc-key.ts'

export { RFC_KEY }

export const ACCOUNT = { login: 'test-account', password: 'pa55-w0rd!', totpSecret: RFC_KEY }
/** A recipe whose step signs in through callbacks, as the folder `--recipe` takes. Built-in recipes don't sign in. */
export const SIGN_IN_RECIPE_DIR = fileURLToPath(new URL('./fixtures/signin-test/', import.meta.url))
export const signInRef: RecipeRef = await recipeRef(SIGN_IN_RECIPE_DIR)
export const signInRecipe: Recipe = await resolveRecipe(signInRef)

export interface World {
  dir: string
  env: NodeJS.ProcessEnv
  backend: FakeBackend
  guest: GuestState
  engine: Sandboxes
  secrets: Secrets
  clock: { now: number }
  cleanup(): Promise<void>
}

/** A fake backend with fake sandboxes, an engine on it, and a client's secrets, in a temporary folder. */
export async function world(options: { secret?: boolean; capabilities?: Partial<Capabilities> } = {}): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'blobby-test-'))
  const env: NodeJS.ProcessEnv = { XDG_STATE_HOME: join(dir, 'state'), XDG_CONFIG_HOME: join(dir, 'config'), BLOBBY_SANDBOX_ALLOWED_LOGINS: ACCOUNT.login }
  const playwright = join(dir, 'playwright-core')
  await mkdir(join(playwright, 'lib'), { recursive: true })
  await writeFile(join(playwright, 'package.json'), '{"name":"playwright-core","version":"1.0.0"}')
  await writeFile(join(playwright, 'lib', 'index.js'), 'module.exports = {}')
  const backend = new FakeBackend({ capabilities: options.capabilities })
  const guest = guestState({ info: { insiders: '1.2.3' } })
  backend.onExec = fakeGuest(backend, guest)
  const engine = new Sandboxes(backend, {
    viewerUp: async () => true,
    playwrightDir: async () => playwright,
    pollMs: 1,
  })
  // One second into a 2FA period, so the first code needs no wait.
  const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 1) }
  const secrets = new Secrets({ env, now: () => clock.now, sleep: async (ms) => void (clock.now += ms) })
  if (options.secret !== false) await secrets.setFile('github', ACCOUNT)
  return { dir, env, backend, guest, engine, secrets, clock, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
