// The library recipe steps import, inside the desktop: ask the client for values, report progress, and
// say what the step did. blobby-sandbox runs each step with BLOBBY_STEP_DIR set to a private folder in memory.
//
//   import { request, progress, done, run } from '/opt/blobby/runtime/lib/blobby.mjs'
//   run(async () => {
//     const login = await request('github.login')
//     progress(`Signing in as ${login}`)
//     done({ github: login })
//   })
//
// A step can ask only for the callbacks its recipe lists in the step's "uses". Sensitive values come
// sealed to a key made for that one request, which never leaves this process. Every value a step gets,
// logins included, is redacted from its progress and errors.
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const INFO = 'blobby-callback-v1'
const secrets = []

/** The bytes both sides bind a sealed answer to: the sandbox, the step, the request, and the callback. */
export function binding(sandbox, step, requestId, name) {
  return [sandbox, step, requestId, name].join('\n')
}

/** Opens an answer that the client sealed to `privateKey`, whose public half is `recipient` (base64url). */
export function openSealed(sealed, privateKey, recipient, bound) {
  if (sealed?.v !== 1) throw new Error('The answer is not a sealed value this version understands')
  const epk = Buffer.from(sealed.epk, 'base64url')
  const shared = diffieHellman({ privateKey, publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: sealed.epk }, format: 'jwk' }) })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, Buffer.from(recipient, 'base64url')]), `${INFO}\n${bound}`, 32))
  const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(sealed.nonce, 'base64url'), { authTagLength: 16 })
  decipher.setAAD(Buffer.from(bound))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64url')), decipher.final()]).toString('utf8')
}

let withheld = false

/**
 * Keeps a value this process got, and from then on replaces it in what the process writes to stdout and
 * stderr: that output goes back through blobby-sandbox, and through a server when there is one.
 */
function remember(value) {
  secrets.push(value)
  if (withheld) return
  withheld = true
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream)
    stream.write = (chunk, ...rest) =>
      write(typeof chunk === 'string' ? redact(chunk) : chunk instanceof Uint8Array ? Buffer.from(redact(Buffer.from(chunk).toString('utf8'))) : chunk, ...rest)
  }
}

/** Replaces every value this step got, such as a password or a login. */
export function redact(text) {
  return secrets.reduce((out, secret) => (secret.length >= 4 ? out.split(secret).join('***') : out), String(text))
}

function stepDir() {
  const dir = process.env.BLOBBY_STEP_DIR
  if (!dir) throw new Error('BLOBBY_STEP_DIR is not set: blobby-sandbox runs recipe steps, not people')
  return dir
}

let cached
function spec() {
  cached ??= JSON.parse(readFileSync(join(stepDir(), 'spec.json'), 'utf8'))
  return cached
}

function writeAtomic(path, text) {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

/** Asks the client for a callback's value, and waits for the answer. */
export async function request(name, { timeoutMs = 180_000 } = {}) {
  const { sandbox, step, callbacks } = spec()
  const callback = callbacks[name]
  if (!callback) {
    throw new Error(`This step cannot ask for ${name}. A recipe step lists what it asks for in "uses" in recipe.json; a command run with --secret asks for its login, username, email, password, otp, or token.`)
  }
  const id = randomBytes(8).toString('hex')
  const ask = { id, name, sensitive: Boolean(callback.sensitive) }
  let keys
  if (ask.sensitive) {
    keys = generateKeyPairSync('x25519')
    ask.publicKey = keys.publicKey.export({ format: 'jwk' }).x
  }
  const requestFile = join(stepDir(), 'requests', `${id}.json`)
  const answerFile = join(stepDir(), 'answers', `${id}.json`)
  writeAtomic(requestFile, JSON.stringify(ask))
  const deadline = Date.now() + timeoutMs
  let answer
  while (!answer) {
    try {
      answer = JSON.parse(readFileSync(answerFile, 'utf8'))
    } catch {
      if (Date.now() > deadline) throw new Error(`No answer for ${name}. Is the blobby-sandbox client still running?`)
      await sleep(200)
    }
  }
  rmSync(answerFile, { force: true })
  rmSync(requestFile, { force: true })
  if (typeof answer.error === 'string') throw new Error(answer.error)
  if (!ask.sensitive) {
    if (typeof answer.value !== 'string') throw new Error(`The answer for ${name} is not text`)
    remember(answer.value)
    return answer.value
  }
  const value = openSealed(answer.sealed, keys.privateKey, ask.publicKey, binding(sandbox, step, id, name))
  remember(value)
  return value
}

/**
 * Asks for a field of the secret a command was given with `blobby-sandbox exec <name> --secret <secret>`,
 * such as `login`, `password`, `otp` (a current 2FA code), or `token`.
 */
export function secret(field, options) {
  const name = process.env.BLOBBY_SECRET
  if (!name) throw new Error('BLOBBY_SECRET is not set: run this with `blobby-sandbox exec <name> --secret <secret> -- ...`')
  return request(`${name}.${field}`, options)
}

/** The name of the secret a command was given with `--secret`, to report accounts with `done({ [secretName()]: login })`. */
export function secretName() {
  const name = process.env.BLOBBY_SECRET
  if (!name) throw new Error('BLOBBY_SECRET is not set: run this with `blobby-sandbox exec <name> --secret <secret> -- ...`')
  return name
}

/** Shows a line of progress to whoever started the desktop. */
export function progress(message) {
  appendFileSync(join(stepDir(), 'progress.log'), `${redact(message).replace(/\s*\n\s*/g, ' ')}\n`)
}

/** Says what the step did, such as the accounts it signed in: `{ github: 'login' }`. */
export function done(result = {}) {
  writeAtomic(join(stepDir(), 'result.json'), JSON.stringify(result))
}

/** Runs a step's main function, and reports its error without any sensitive value in it. */
export async function run(main) {
  try {
    await main()
    process.exit(0)
  } catch (error) {
    const message = redact(String(error?.message ?? error).split('\n')[0])
    try {
      writeAtomic(join(stepDir(), 'error.json'), JSON.stringify({ message }))
    } catch {
      process.stderr.write(`${message}\n`)
    }
    process.exit(1)
  }
}
