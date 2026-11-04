import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { SandboxError } from '../backend.ts'

/**
 * A value sealed to the one-time key a sandbox made for one callback request: X25519, HKDF-SHA256, and
 * ChaCha20-Poly1305. Only the process that asked can open it; anything that carries it, the server
 * and the backend included, sees only ciphertext. The sandbox opens it with `openSealed` in
 * `runtime/lib/blobby.mjs`.
 */
export interface Sealed {
  v: 1
  /** The sender's one-time public key, base64url. */
  epk: string
  nonce: string
  ct: string
  tag: string
}

const INFO = 'blobby-callback-v1'
const KEY = /^[A-Za-z0-9_-]{43}$/

/** What a sealed answer is bound to, so it can't be replayed for another sandbox, step, request, or callback. */
export function binding(sandbox: string, step: string, requestId: string, name: string): string {
  return [sandbox, step, requestId, name].join('\n')
}

/** Seals `value` to `recipient`, a raw X25519 public key in base64url. */
export function seal(value: string, recipient: string, bound: string): Sealed {
  if (!KEY.test(recipient)) throw new SandboxError('invalid_key', 'The sandbox sent a request without a valid public key.')
  const ephemeral = generateKeyPairSync('x25519')
  const epk = ephemeral.publicKey.export({ format: 'jwk' }).x!
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: recipient }, format: 'jwk' }),
  })
  const salt = Buffer.concat([Buffer.from(epk, 'base64url'), Buffer.from(recipient, 'base64url')])
  const key = Buffer.from(hkdfSync('sha256', shared, salt, `${INFO}\n${bound}`, 32))
  const nonce = randomBytes(12)
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(bound), { plaintextLength: Buffer.byteLength(value) })
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return { v: 1, epk, nonce: nonce.toString('base64url'), ct: ct.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
}
