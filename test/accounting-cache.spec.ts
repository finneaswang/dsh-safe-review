import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountingSchema, summarizeAccounting, type UsageAccounting } from '../src/usage-accounting.js'
import { createUsageCache } from '../src/usage-cache.js'
import type { CompletionUsageRow, CompletionUsageSnapshot, CostsSnapshot } from '../src/usage-api.js'

const child = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: child.exec }))
const now = Date.parse('2026-10-11T12:00:00Z')
const midnight = Date.parse('2026-10-11T00:00:00Z') / 1000
const monthStart = Date.parse('2026-10-01T00:00:00Z') / 1000
const stops: Array<() => void> = []
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function account(overrides: Partial<UsageAccounting> = {}): UsageAccounting {
  return { version: 1, day: '2026-10-11', fetchedAt: now, primaryUsed: 100, secondaryUsed: 50,
    unmappedTokens: 0, todayUsd: null, monthUsd: null, costsFetchedAt: null, ...overrides }
}
function row(model: string | null, inputTokens = 100, outputTokens = 20): CompletionUsageRow {
  return { bucketStart: midnight, bucketEnd: midnight + 86400, model, projectId: 'proj_test',
    serviceTier: 'default', inputTokens, outputTokens, inputCachedTokens: 50, numModelRequests: 1 }
}
function usage(rows: CompletionUsageRow[] = [row('gpt-6-astra')]): CompletionUsageSnapshot {
  return { startTime: midnight, endTime: now / 1000, fetchedAt: now, rows }
}
function costs(): CostsSnapshot {
  return { startTime: monthStart, endTime: now / 1000, fetchedAt: now, rows: [
    { bucketStart: monthStart, bucketEnd: monthStart + 86400, projectId: 'proj_other', lineItem: 'usage', currency: 'usd', amount: 2 },
    { bucketStart: midnight, bucketEnd: midnight + 86400, projectId: 'proj_test', lineItem: 'usage', currency: 'usd', amount: 0.5 },
    { bucketStart: midnight, bucketEnd: midnight + 86400, projectId: null, lineItem: 'credit', currency: 'usd', amount: -0.1 },
  ] }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); child.exec.mockReset() })
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers(); vi.unstubAllEnvs() })

describe('UTC accounting aggregation', () => {
  it('includes all projects/service tiers and charges unknown models to both estimates', () => {
    const values = [row('gpt-6-astra'), row('gpt-5.6-terra-2026-09-01'),
      { ...row('unknown', 10, 2), projectId: 'proj_other', serviceTier: 'priority' }, row(null, 3, 4)]
    const result = summarizeAccounting(usage(values))
    expect(result).toMatchObject({ primaryUsed: 139, secondaryUsed: 139, unmappedTokens: 19 })
    expect(result).not.toHaveProperty('freeRemaining')
    expect(result).not.toHaveProperty('balanceUsd')
  })
  it('accepts full daily buckets extending past query end and separates month/day costs', () => {
    expect(summarizeAccounting(usage(), costs())).toMatchObject({ primaryUsed: 120,
      todayUsd: 0.4, monthUsd: 2.4, costsFetchedAt: now })
  })
  it.each([
    { startTime: midnight + 1 }, { endTime: midnight }, { endTime: midnight - 1 },
    { endTime: midnight + 86401 }, { endTime: now / 1000 + 0.5 }, { fetchedAt: (midnight - 1) * 1000 },
  ])('rejects an invalid daily query or receipt: %j', overrides => {
    expect(() => summarizeAccounting({ ...usage(), ...overrides })).toThrow()
  })
  it.each([
    { startTime: midnight }, { startTime: monthStart - 86400 }, { endTime: now / 1000 - 1 },
    { fetchedAt: (midnight - 1) * 1000 },
  ])('keeps valid token usage but omits costs from the wrong period: %j', overrides => {
    expect(summarizeAccounting(usage(), { ...costs(), ...overrides })).toMatchObject({ primaryUsed: 120,
      todayUsd: null, monthUsd: null, costsFetchedAt: null })
  })
  it('omits unsupported currencies and invalid costs rows without fabricating zero spend', () => {
    for (const overrides of [{ currency: 'eur' }, { amount: Number.NaN }, { bucketStart: monthStart - 1 }]) {
      const invalid = costs(); invalid.rows = [{ ...invalid.rows[0]!, ...overrides }]
      expect(summarizeAccounting(usage(), invalid)).toMatchObject({ primaryUsed: 120, todayUsd: null, monthUsd: null })
    }
  })
  it('rejects invalid or compensating-negative token rows', () => {
    expect(() => summarizeAccounting(usage([row('gpt-6-astra', -1, 100)]))).toThrow()
    expect(() => summarizeAccounting(usage([{ ...row('gpt-6-astra'), bucketStart: midnight - 86400 }]))).toThrow()
  })
  it.each([
    { day: '2026-02-30' }, { day: '2026-13-01' }, { fetchedAt: (midnight - 1) * 1000 },
    { costsFetchedAt: (midnight - 1) * 1000 }, { todayUsd: 5 }, { extra: 'secret' },
  ])('strict schema rejects inconsistent accounting: %j', overrides => {
    expect(accountingSchema.safeParse({ ...account(), ...overrides }).success).toBe(false)
  })
})

describe('isolated usage cache', () => {
  it('merges startup and concurrent refreshes, then polls no faster than once a minute', async () => {
    let resolve!: (value: unknown) => void
    const worker = vi.fn(() => new Promise(done => { resolve = done }))
    const cache = createUsageCache('/unused/admin.key', worker); stops.push(cache.stop)
    const first = cache.get(), second = cache.get()
    expect(worker).toHaveBeenCalledOnce()
    resolve(account()); await Promise.all([first, second])
    expect(cache.peek()).toEqual(account())
    await vi.advanceTimersByTimeAsync(59_999)
    await cache.get(); expect(worker).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(worker).toHaveBeenCalledTimes(2)
    resolve(account({ fetchedAt: now + 60_000 })); await flush()
  })
  it('retains original timestamps after failure and never freshens a stale snapshot', async () => {
    const worker = vi.fn().mockResolvedValueOnce(account()).mockRejectedValue(new Error('offline'))
    const cache = createUsageCache('/unused/admin.key', worker); stops.push(cache.stop)
    await cache.get(); await vi.advanceTimersByTimeAsync(360_000)
    expect((await cache.get())?.fetchedAt).toBe(now)
    expect(Date.now() - cache.peek()!.fetchedAt).toBe(360_000)
  })
  it('rejects old-day, future and malformed worker snapshots', async () => {
    for (const invalid of [account({ day: '2026-10-10' }), account({ fetchedAt: now + 1001 }), { ...account(), injected: 'data' }]) {
      const cache = createUsageCache('/unused/admin.key', async () => invalid); stops.push(cache.stop)
      expect(await cache.get()).toBeUndefined()
    }
  })
  it('cannot install a result after stop, and stops future refreshes', async () => {
    let resolve!: (value: unknown) => void
    const worker = vi.fn(() => new Promise(done => { resolve = done }))
    const cache = createUsageCache('/unused/admin.key', worker); stops.push(cache.stop)
    const pending = cache.get(); cache.stop(); resolve(account())
    expect(await pending).toBeUndefined()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await cache.get()).toBeUndefined(); expect(worker).toHaveBeenCalledOnce()
  })
  it('starts only a fixed Node worker with a clean environment and a process timeout', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'must-not-inherit')
    vi.stubEnv('OPENAI_ADMIN_KEY', 'must-not-inherit')
    vi.stubEnv('NODE_OPTIONS', '--import=must-not-inherit')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '0')
    child.exec.mockImplementation((_binary, _args, _options, callback) => { callback(null, JSON.stringify(account())) })
    const cache = createUsageCache('/fixture/admin-usage.key'); stops.push(cache.stop)
    expect(await cache.get()).toEqual(account())
    const [binary, args, options] = child.exec.mock.calls[0]!
    expect(binary).toBe(process.execPath)
    expect(args).toHaveLength(2); expect(args[0]).toMatch(/\/usage-worker\.js$/)
    expect(args[1]).toBe('/fixture/admin-usage.key')
    expect(options).toMatchObject({ env: { LANG: 'en_US.UTF-8', ELECTRON_RUN_AS_NODE: '1' }, timeout: 15_000, maxBuffer: 16_384 })
    expect(Object.keys(options.env).sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'LANG'])
    expect(options.shell).toBeUndefined()
  })
})
