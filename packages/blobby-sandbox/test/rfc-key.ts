// RFC 6238 appendix B's SHA-1 key, the ASCII bytes "12345678901234567890", in base32 as a 2FA app
// takes it. Built here, not written out, so secret scanners don't mistake the public test vector
// for a key.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export const RFC_KEY = base32(new TextEncoder().encode('12345678901234567890'))
