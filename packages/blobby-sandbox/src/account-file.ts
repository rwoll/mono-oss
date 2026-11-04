import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { SandboxError } from './backend.ts'
import { decodeBase32 } from './callbacks/totp.ts'
import { displayPath } from './paths.ts'

/** An account file is a few short fields; anything larger is something else. */
export const ACCOUNT_FILE_MAX_BYTES = 4096

/** A test account's login, password, and 2FA key, as `Secrets` reads them. */
export interface AccountValues {
  login: string
  password: string
  totpSecret: string
}

const fail = (message: string) => new SandboxError('invalid_secret', message)

/**
 * Reads a test-account file that the user keeps, by path: their own regular file, readable by nobody
 * else (mode 600 or stricter), at most 4 KB, of JSON with string `username`, `password`, and `totp_key`.
 * With `contents: false`, it checks only the file, without reading it. Errors name the file, but never
 * quote what is in it.
 */
export async function readAccountFile(path: string, options: { contents?: boolean } = {}): Promise<AccountValues | null> {
  const file = displayPath(path)
  // Non-blocking, so a FIFO in its place can't hang the read; the checks below refuse it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw fail(`The account file ${file} is missing. Restore it, or point the secret at another: blobby-sandbox secrets set <name> --file <path>.`)
    throw fail(`blobby-sandbox can't open the account file ${file} (${error.code ?? 'error'}).`)
  })
  let data: Buffer | null = null
  try {
    // The same open file is checked and read, so it can't be swapped in between.
    const info = await handle.stat()
    if (!info.isFile()) throw fail(`The account file ${file} is not a regular file.`)
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw fail(`The account file ${file} must belong to you.`)
    if ((info.mode & 0o077) !== 0) throw fail(`Other users can read or change the account file ${file}. Run: chmod 600 ${file}`)
    if (info.size > ACCOUNT_FILE_MAX_BYTES) throw fail(`The account file ${file} is larger than ${ACCOUNT_FILE_MAX_BYTES} bytes, so it isn't an account file.`)
    if (options.contents === false) return null
    data = Buffer.alloc(ACCOUNT_FILE_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(data, 0, data.length, 0)
    if (bytesRead > ACCOUNT_FILE_MAX_BYTES) throw fail(`The account file ${file} is larger than ${ACCOUNT_FILE_MAX_BYTES} bytes, so it isn't an account file.`)
    let value: unknown
    try {
      value = JSON.parse(data.subarray(0, bytesRead).toString('utf8'))
    } catch {
      // JSON.parse errors quote the input, so they are never passed on.
      throw fail(`The account file ${file} is not valid JSON.`)
    }
    const { username, password, totp_key: key } = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password || typeof key !== 'string' || !key) {
      throw fail(`The account file ${file} needs text username, password, and totp_key fields.`)
    }
    if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(username)) throw fail(`The username in the account file ${file} is not a GitHub username.`)
    try {
      decodeBase32(key)
    } catch {
      throw fail(`The totp_key in the account file ${file} is not base32.`)
    }
    return { login: username, password, totpSecret: key }
  } finally {
    data?.fill(0)
    await handle.close()
  }
}
