import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { accountingSchema, type UsageAccounting } from './usage-accounting.js'

/** Contains numbers only. The host never receives the Admin Key or raw API bodies. */
export function createUsageCache(keyFile: string, runWorker?: () => Promise<unknown>) {
  let cached: UsageAccounting | undefined
  let flight: Promise<UsageAccounting | undefined> | undefined
  let stopped = false
  let lastAttempt = 0
  const stop = new AbortController()
  const run = runWorker ?? (() => new Promise<unknown>((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(new URL('./usage-worker.js', import.meta.url)), keyFile], {
      timeout: 15_000, maxBuffer: 16_384, encoding: 'utf8', signal: stop.signal,
      // Do not inherit inference credentials, NODE_OPTIONS, or an agent-modifiable environment.
      // Desktop hosts run under the Electron executable. Without this fixed
      // flag a child launches the GUI instead of running the accounting script.
      env: { LANG: 'en_US.UTF-8', ELECTRON_RUN_AS_NODE: '1' },
    }, (error, stdout) => {
      if (error) { reject(new Error('Accounting worker unavailable.')); return }
      try { resolve(JSON.parse(stdout) as unknown) } catch { reject(new Error('Accounting worker returned invalid data.')) }
    })
  }))
  const refresh = async (): Promise<UsageAccounting | undefined> => {
    if (stopped) return undefined
    if (flight) return flight
    if (Date.now() - lastAttempt < 60_000) return cached
    lastAttempt = Date.now()
    flight = (async () => {
      try {
        const value = accountingSchema.parse(await run())
        if (value.day !== new Date().toISOString().slice(0, 10) || value.fetchedAt > Date.now() + 1000) throw new Error('Stale or future accounting data.')
        if (!stopped) cached = value
      } catch { /* Preserve its timestamp; stale data cannot authorize another review. */ }
      finally { flight = undefined }
      return stopped ? undefined : cached
    })()
    return flight
  }
  const timer = setInterval(() => { void refresh() }, 60_000)
  timer.unref()
  void refresh()
  return { get: refresh, peek: () => cached, stop: () => { stopped = true; stop.abort(); clearInterval(timer) } }
}
