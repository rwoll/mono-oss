// One sign-in, in its own process, for the concurrency test: takes the account's lock, gets a 2FA code,
// holds the lock a moment, and prints what happened as JSON lines. Its clock runs `scale` times faster
// than the wall clock from the moment the test says go, so periods pass in a test's time.
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { SignIns } from '../../src/callbacks/signin.ts'
import { RFC_KEY } from '../rfc-key.ts'

const [configHome, base, scale, holdMs] = process.argv.slice(2).map((value, index) => (index === 0 ? value : Number(value))) as [string, number, number, number]
const say = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`)

say({ event: 'ready' })
const lines = createInterface({ input: process.stdin })
const goAt = Number(await new Promise<string>((resolve) => lines.once('line', resolve)))
lines.close()
await delay(Math.max(0, goAt - Date.now()))

const now = () => base + (Date.now() - goAt) * scale
const signIns = new SignIns({ env: { XDG_CONFIG_HOME: configHome }, now, sleep: (ms) => delay(ms / scale) })
const account = 'login-test-account'
const onWait = (line: string) => say({ event: 'wait', line })
await signIns.hold(account, 'github', async () => {
  say({ event: 'acquired', at: now() })
  await signIns.nextCode(account, RFC_KEY, 'github', { onWait })
  say({ event: 'code', period: await signIns.lastPeriod(account) })
  await delay(holdMs)
  say({ event: 'releasing', at: now() })
}, { onWait })
