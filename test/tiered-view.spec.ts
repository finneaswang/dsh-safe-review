import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTieredReview, REVIEW_TIERS } from '../src/tiered-review.js'
import { TierBudget } from '../src/tier-budget.js'
import { DailyBudget } from '../src/budget.js'
import type { UsageAccounting } from '../src/usage-accounting.js'
import { publicUsageSnapshot } from '../src/usage-contract.js'

// Mock only the external reporting cache. Every controller request uses the real
// on-disk ledger, lock, migration and UTC accounting code; no keys are loaded.
const cache = vi.hoisted(() => ({
  value: undefined as UsageAccounting | undefined,
  get: vi.fn<() => Promise<UsageAccounting | undefined>>(),
  peek: vi.fn<() => UsageAccounting | undefined>(),
  stop: vi.fn(),
}))
vi.mock('../src/usage-cache.js', () => ({ createUsageCache: () => cache }))

const directories: string[] = []
const firstDay = Date.parse('2026-10-11T12:00:00Z')
let now = firstDay
function accounting(primaryUsed = 100, secondaryUsed = 200, fetchedAt = now): UsageAccounting {
  return { version: 1, day: new Date(fetchedAt).toISOString().slice(0, 10), fetchedAt,
    primaryUsed, secondaryUsed, unmappedTokens: 0, todayUsd: null, monthUsd: null, costsFetchedAt: null }
}
async function fixture(overrides: { primaryTokens?: number; secondaryTokens?: number; paidDailyUsd?: number } = {}) {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tiered-view-test-')))
  directories.push(dataDir)
  const options = { dataDir, primaryTokens: 1000, secondaryTokens: 2000, paidDailyUsd: 1, ...overrides }
  const view = createTieredReview(options)
  const budget = new TierBudget({ directory: join(dataDir, 'budget'), tiers: REVIEW_TIERS,
    paidDailyBudgetMicrousd: Math.round(options.paidDailyUsd * 1_000_000) })
  return { dataDir, options, view, budget }
}
const request = (attemptId: string) => ({ attemptId, inputTokenUpperBound: 80, outputTokenLimit: 20 })
const signal = () => new AbortController().signal

beforeEach(() => {
  now = firstDay
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  cache.value = accounting()
  cache.get.mockImplementation(async () => cache.value)
  cache.peek.mockImplementation(() => cache.value)
})
afterEach(async () => {
  vi.restoreAllMocks()
  cache.get.mockReset()
  cache.peek.mockReset()
  cache.stop.mockReset()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('real tier ledger and public controller view', () => {
  it('establishes the first baseline in the UI before any review and keeps official and estimated values separate', async () => {
    const { view, budget } = await fixture()
    const s = publicUsageSnapshot(await view.snapshot())
    expect(s.status).toBe('ready')
    expect(s.tiers[0]?.allowance).toEqual({ limitTokens: 1000, usedTokens: 100, remainingTokens: 900,
      source: 'local-estimate', updatedAt: now, officialUsedTokens: 100, officialUsageUpdatedAt: now })
    expect((await budget.snapshot()).tiers.high.reservedRequests).toBe(0)
    expect(s.accountCredit).toEqual({ balanceUsd: null, source: 'unknown', updatedAt: null })
    expect(s.tiers[2]?.allowance).toBeNull()
  })

  it('uses the same merged estimate for the UI and routing after an external usage increase with a pending review', async () => {
    const { view, budget } = await fixture()
    const held = await view.routing.reserve(request('pending'), signal())
    expect(held?.model).toBe(REVIEW_TIERS.high.model)
    now += 1000
    cache.value = accounting(500)
    const s = publicUsageSnapshot(await view.snapshot())
    const ledger = await budget.snapshot()
    expect(s.tiers[0]?.allowance).toMatchObject({ usedTokens: 600, remainingTokens: 400, officialUsedTokens: 500 })
    expect(s.tiers[0]?.allowance?.usedTokens).toBe(ledger.freePools?.high.estimatedUsed)
    expect(s.tiers[0]?.allowance?.remainingTokens).toBe(ledger.freePools?.high.estimatedRemaining)
    expect(s.tiers[0]?.localUsedTokens).toBe(100)
  })

  it('does not invent usage when configured pool limits change after restart', async () => {
    const { view, options } = await fixture()
    await view.routing.reserve(request('pending'), signal())
    now += 1000
    cache.value = accounting(100)
    const restarted = createTieredReview({ ...options, primaryTokens: 6000 })
    const s = publicUsageSnapshot(await restarted.snapshot())
    expect(s.tiers[0]?.allowance).toMatchObject({ limitTokens: 6000, usedTokens: 200, remainingTokens: 5800 })
  })

  it('does not double-deduct settled local tokens when the official report catches up', async () => {
    const { view } = await fixture()
    const held = await view.routing.reserve(request('first'), signal())
    expect(held).toBeDefined()
    await view.routing.settle(held!.reservation, { inputTokens: 60, outputTokens: 10 })
    expect((await view.snapshot()).tiers[0]?.allowance?.usedTokens).toBe(170)
    now += 1000
    cache.value = accounting(170)
    const s = publicUsageSnapshot(await view.snapshot())
    expect(s.tiers[0]?.allowance).toMatchObject({ usedTokens: 170, remainingTokens: 830, officialUsedTokens: 170 })
  })

  it('keeps stale usage unknown and does not advertise a current official timestamp', async () => {
    const { view, budget } = await fixture()
    await view.snapshot()
    now += 300_001
    const s = publicUsageSnapshot(await view.snapshot())
    expect(s.status).toBe('unavailable')
    expect(s.tiers[0]?.allowance).toMatchObject({ usedTokens: null, remainingTokens: null, source: 'unknown',
      updatedAt: null, officialUsedTokens: null, officialUsageUpdatedAt: null })
    expect(await view.routing.reserve(request('stale'), signal())).toBeUndefined()
    expect((await budget.snapshot()).tiers.high.reservedRequests).toBe(0)
  })

  it('does not let a future official timestamp authorize routing or advertise a current balance', async () => {
    const { view } = await fixture()
    cache.value = accounting(100, 200, now + 1)
    expect(await view.routing.reserve(request('future'), signal())).toBeUndefined()
    const s = publicUsageSnapshot(await view.snapshot())
    expect(s.status).toBe('unavailable')
    expect(s.tiers[0]?.allowance).toMatchObject({ usedTokens: null, officialUsageUpdatedAt: null })
  })

  it('handles UTC rollover and a late previous-day response without changing the new charge', async () => {
    const { view, budget } = await fixture({ primaryTokens: 0, secondaryTokens: 0 })
    const yesterday = await view.routing.reserve(request('yesterday'), signal())
    expect(yesterday?.model).toBe(REVIEW_TIERS.paid.model)
    now = Date.parse('2026-10-12T00:00:00Z')
    let s = publicUsageSnapshot(await view.snapshot())
    expect(s.status).toBe('unavailable')
    expect(s.activeTier).toBe('free-primary')
    expect(s.lastSwitch?.reason).toBe('daily-reset')
    expect(s.tiers.every(t => t.localUsedTokens === 0)).toBe(true)
    cache.value = accounting(0, 0)
    const today = await view.routing.reserve(request('today'), signal())
    expect(today?.model).toBe(REVIEW_TIERS.paid.model)
    await view.routing.settle(yesterday!.reservation, { inputTokens: 1, outputTokens: 1 })
    expect((await budget.snapshot()).tiers.paid.tokens).toBe(100)
    s = publicUsageSnapshot(await view.snapshot())
    expect(s.status).toBe('ready')
    expect(s.resetsAt).toBe(Date.parse('2026-10-13T00:00:00Z'))
  })

  it('uses the same legacy budget directory and refuses duplicate attempts after restart', async () => {
    const { view, budget, options, dataDir } = await fixture()
    await new DailyBudget({ directory: join(dataDir, 'budget'), dailyTokenLimit: 1000 }).reserve(300)
    const held = await view.routing.reserve(request('stable-attempt'), signal())
    expect(held).toBeDefined()
    const restarted = createTieredReview(options)
    expect(await restarted.routing.reserve(request('stable-attempt'), signal())).toBeUndefined()
    const s = publicUsageSnapshot(await restarted.snapshot())
    expect(s.tiers[0]?.localUsedTokens).toBe(100)
    expect(s.tiers[1]).toMatchObject({ localUsedTokens: 300, estimatedCostUsd: null })
    expect((await budget.snapshot()).tiers.high.reservedRequests).toBe(1)
  })

  it('reports paid exhaustion using its dedicated notification reason and persistent sequence', async () => {
    const { view, options } = await fixture({ primaryTokens: 0, secondaryTokens: 0, paidDailyUsd: 0 })
    expect(await view.routing.reserve(request('blocked'), signal())).toBeUndefined()
    const first = publicUsageSnapshot(await view.snapshot())
    expect(first.lastSwitch).toMatchObject({ reason: 'paid-budget-exhausted', to: 'paid' })
    const restarted = createTieredReview(options)
    expect((await restarted.snapshot()).lastSwitch).toEqual(first.lastSwitch)
    now += 86_400_000
    cache.value = accounting(0, 0)
    const next = publicUsageSnapshot(await restarted.snapshot())
    expect(next.lastSwitch?.reason).toBe('daily-reset')
    expect(next.lastSwitch!.sequence).toBe(first.lastSwitch!.sequence + 1)
  })

  it('does not create a reservation when the request is already aborted', async () => {
    const { view, dataDir } = await fixture()
    const cancelled = new AbortController()
    cancelled.abort()
    expect(await view.routing.reserve(request('cancelled'), cancelled.signal)).toBeUndefined()
    expect(cache.get).not.toHaveBeenCalled()
    await expect(readFile(join(dataDir, 'budget', 'tier-budget.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not charge a request that times out while awaiting the external usage report', async () => {
    const { view, dataDir } = await fixture()
    let finish!: (value: UsageAccounting | undefined) => void
    cache.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const cancelled = new AbortController()
    const waiting = view.routing.reserve(request('timed-out'), cancelled.signal)
    cancelled.abort()
    finish(cache.value)
    expect(await waiting).toBeUndefined()
    await expect(readFile(join(dataDir, 'budget', 'tier-budget.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
