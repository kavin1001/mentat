import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRelay } from './server'

const dbPath = process.env.MENTAT_SYNC_DB ?? './data/mentat-sync.db'
mkdirSync(dirname(dbPath), { recursive: true })
const port = Number(process.env.PORT ?? 8787)

const { server } = createRelay({
  dbPath,
  name: process.env.MENTAT_SYNC_NAME,
  signupCode: process.env.MENTAT_SIGNUP_CODE || undefined,
  allowSignups: process.env.MENTAT_ALLOW_SIGNUPS !== 'false',
  serverSecret: process.env.MENTAT_SERVER_SECRET || undefined
})
server.listen(port, () => console.log(`mentat sync relay on :${port} (db ${dbPath})`))
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)))
