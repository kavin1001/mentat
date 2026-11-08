// Hermes has no WebCrypto; the sync crypto (noble) only needs crypto.getRandomValues.
import { getRandomValues } from 'expo-crypto'

const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } }
if (!g.crypto) g.crypto = {}
if (typeof g.crypto.getRandomValues !== 'function') g.crypto.getRandomValues = getRandomValues
