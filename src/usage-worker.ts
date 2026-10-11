/** One-shot child process. Only this process loads the separate administration key. */
import { isAbsolute } from 'node:path'
import { loadAdminUsageKey } from './admin-credentials.js'
import { OpenAIUsageApi } from './usage-api.js'
import { summarizeAccounting } from './usage-accounting.js'

async function main(): Promise<void> {
  const keyFile = process.argv[2]
  if (process.argv.length !== 3 || !keyFile || !isAbsolute(keyFile)) throw new Error('Invalid worker input.')
  const now = Date.now()
  const date = new Date(now)
  const startTime = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000
  const endTime = Math.max(startTime + 1, Math.floor(now / 1000))
  const api = new OpenAIUsageApi({ loadAdminKey: () => loadAdminUsageKey(keyFile), timeoutMs: 12_000 })
  const [usage, costs] = await Promise.all([
    api.completions({ startTime, endTime }),
    api.costs({ startTime: monthStart, endTime }).catch(() => undefined),
  ])
  process.stdout.write(JSON.stringify(summarizeAccounting(usage, costs)))
}
main().catch(() => { process.stderr.write('Account usage is unavailable.\n'); process.exitCode = 1 })
