import { createHmac } from 'node:crypto'
import { SandboxError } from '../backend.ts'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const PERIOD_MS = 30_000

export function decodeBase32(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase()
  if (!clean || [...clean].some((character) => !BASE32.includes(character))) {
    throw new SandboxError('invalid_totp_key', 'The 2FA setup key is not base32 (letters A to Z and digits 2 to 7).')
  }
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const character of clean) {
    value = (value << 5) | BASE32.indexOf(character)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** The RFC 6238 code for `key` at `at` milliseconds: SHA-1, 30-second periods. */
export function totp(key: string, at = Date.now(), digits = 6): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / PERIOD_MS)))
  const hmac = createHmac('sha1', decodeBase32(key)).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(code).padStart(digits, '0')
}
