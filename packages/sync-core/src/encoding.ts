// Small, dependency-free base64 so the same code runs in Node, Electron and React Native (Hermes).
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Uint8Array(128)
for (let i = 0; i < ALPHA.length; i++) LOOKUP[ALPHA.charCodeAt(i)] = i
LOOKUP['-'.charCodeAt(0)] = 62
LOOKUP['_'.charCodeAt(0)] = 63

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63] + ALPHA[(n >> 6) & 63] + ALPHA[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63] + '=='
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63] + ALPHA[(n >> 6) & 63] + '='
  }
  return out
}

export function fromBase64(b64: string): Uint8Array {
  const s = b64.replace(/[=\s]/g, '')
  if (/[^A-Za-z0-9+/\-_]/.test(s)) throw new Error('invalid base64')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let o = 0
  for (let i = 0; i < s.length; i += 4) {
    const n =
      (LOOKUP[s.charCodeAt(i)] << 18) |
      (LOOKUP[s.charCodeAt(i + 1)] << 12) |
      ((i + 2 < s.length ? LOOKUP[s.charCodeAt(i + 2)] : 0) << 6) |
      (i + 3 < s.length ? LOOKUP[s.charCodeAt(i + 3)] : 0)
    out[o++] = (n >> 16) & 255
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255
    if (i + 3 < s.length) out[o++] = n & 255
  }
  return out.subarray(0, o)
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
