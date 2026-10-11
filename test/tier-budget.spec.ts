import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { DailyBudget } from '../src/budget.js'
import { TierBudget, estimateRetailCostMicrousd, type TierBudgetOptions, type TierQuotaSnapshot, type TierReservation, type TierReserveResult } from '../src/tier-budget.js'

const faults = vi.hoisted(() => ({ rename: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: async (...args: Parameters<typeof original.rename>) => {
    if (faults.rename) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' })
    return original.rename(...args)
  } }
})

const execute = promisify(execFile)
const directories: string[] = []
const day1 = Date.parse('2026-10-11T12:00:00Z')
const day2 = Date.parse('2026-10-12T00:00:00Z')
const rates: TierBudgetOptions['tiers'] = {
  high: { model: 'gpt-high-fixture', inputMicrousdPerMillion: 2_000_000, outputMicrousdPerMillion: 8_000_000 },
  middle: { model: 'gpt-middle-fixture', inputMicrousdPerMillion: 1_000_000, outputMicrousdPerMillion: 4_000_000 },
  paid: { model: 'gpt-paid-fixture', inputMicrousdPerMillion: 500_000, outputMicrousdPerMillion: 1_000_000 },
}
function quota(now = day1, highLimit = 1000, middleLimit = 2000, highUsed = 0, middleUsed = 0): TierQuotaSnapshot {
  return { day: new Date(now).toISOString().slice(0, 10), fetchedAt: now, pools: { high: { used: highUsed, limit: highLimit }, middle: { used: middleUsed, limit: middleLimit } } }
}
function receipt(value: TierReserveResult): TierReservation {
  expect(value.kind).toBe('reserved')
  if (value.kind !== 'reserved') throw new Error(value.reason)
  return value.reservation
}
async function fixture(options: Partial<Omit<TierBudgetOptions, 'directory'>> = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tier-budget-test-')))
  directories.push(base)
  const directory = join(base, 'state')
  const config = { directory, tiers: rates, now: () => day1, ...options }
  return { base, directory, config, budget: new TierBudget(config) }
}
function reserve(budget: TierBudget, attemptId: string, snapshot: TierQuotaSnapshot = quota(), input = 80, output = 20) {
  return budget.reserve({ attemptId, inputTokenUpperBound: input, outputTokenLimit: output, quota: snapshot })
}
afterEach(async () => {
  faults.rename = false
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('token-pool tier routing', () => {
  it('persists a complete high-tier reservation before returning it', async () => {
    const { budget, directory } = await fixture()
    const r = receipt(await reserve(budget, 'first'))
    expect(r).toMatchObject({ tier: 'high', model: rates.high.model, reservedTokens: 100, reservedCostMicrousd: 320 })
    const saved = JSON.parse(await readFile(join(directory, 'tier-budget.json'), 'utf8'))
    expect(saved.attempts.first.receipt).toEqual(r)
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(directory, 'tier-budget.json'))).mode & 0o777).toBe(0o600)
  })

  it('switches by tokens rather than a 50-request count', async () => {
    const { budget } = await fixture()
    for (let i = 0; i < 55; i++) expect(receipt(await reserve(budget, `request-${i}`, quota(day1, 10_000))).tier).toBe('high')
    expect((await budget.snapshot()).tiers.high.reservedRequests).toBe(55)
    expect((await budget.snapshot()).tier).toBe('high')
  })

  it('allows an exact fit and moves the whole next request to the next pool', async () => {
    const { budget } = await fixture()
    expect(receipt(await reserve(budget, 'exact', quota(day1, 1000, 2000, 900))).tier).toBe('high')
    expect(receipt(await reserve(budget, 'next', quota(day1, 1000, 2000, 900))).tier).toBe('middle')
    const s = await budget.snapshot()
    expect(s.freePools?.high).toEqual({ officialUsed: 900, localCharged: 100, limit: 1000, estimatedUsed: 1000, estimatedRemaining: 0 })
  })

  it('keeps pending requests fully reserved even when reporting may already include them', async () => {
    const { budget } = await fixture()
    await reserve(budget, 'one', quota(day1, 150))
    expect(receipt(await reserve(budget, 'two', quota(day1, 150, 2000, 100))).tier).toBe('middle')
    expect((await budget.snapshot()).freePools?.high).toMatchObject({ officialUsed: 100, localCharged: 100, estimatedRemaining: 0 })
  })

  it('captures the first baseline once and excludes already-imported legacy tokens from it', async () => {
    const { budget, directory } = await fixture()
    await new DailyBudget({ directory, dailyTokenLimit: 1000, now: () => day1 }).reserve(300)
    const first = receipt(await reserve(budget, 'first', quota(day1, 2000, 2000, 100, 500)))
    await budget.settle(first, { inputTokens: 50, outputTokens: 10 })
    const initial = await budget.snapshot()
    expect(initial.freePools?.high).toMatchObject({ officialUsed: 100, localCharged: 60, estimatedUsed: 160 })
    expect(initial.freePools?.middle).toMatchObject({ officialUsed: 500, localCharged: 300, estimatedUsed: 500 })
    expect(JSON.parse(await readFile(join(directory, 'tier-budget.json'), 'utf8')).baselineUsed).toEqual({ high: 100, middle: 200 })
    await reserve(budget, 'later', quota(day1, 2000, 2000, 160, 800))
    expect(JSON.parse(await readFile(join(directory, 'tier-budget.json'), 'utf8')).baselineUsed).toEqual({ high: 100, middle: 200 })
  })

  it('does not double-charge settled local usage as official reporting catches up', async () => {
    const { budget } = await fixture()
    const first = receipt(await reserve(budget, 'first', quota(day1, 400)))
    await budget.settle(first, { inputTokens: 80, outputTokens: 20 })
    const second = receipt(await reserve(budget, 'second', quota(day1, 400, 2000, 50)))
    expect(second.tier).toBe('high')
    expect((await budget.snapshot()).freePools?.high?.estimatedUsed).toBe(200)
    await budget.settle(second, { inputTokens: 80, outputTokens: 20 })
    const third = receipt(await reserve(budget, 'third', quota(day1, 400, 2000, 200)))
    expect(third.tier).toBe('high')
    await budget.settle(third, { inputTokens: 80, outputTokens: 20 })
    expect(receipt(await reserve(budget, 'fourth', quota(day1, 400, 2000, 300))).tier).toBe('high')
    expect((await budget.snapshot()).freePools?.high).toMatchObject({ officialUsed: 300, localCharged: 400, estimatedUsed: 400, estimatedRemaining: 0 })
  })

  it('includes reported external usage increases without resetting the baseline', async () => {
    const { budget, directory } = await fixture()
    const first = receipt(await reserve(budget, 'first', quota(day1, 1000, 2000, 100)))
    await budget.settle(first, { inputTokens: 80, outputTokens: 20 })
    await reserve(budget, 'second', quota(day1, 1000, 2000, 350))
    expect((await budget.snapshot()).freePools?.high).toMatchObject({ officialUsed: 350, localCharged: 200, estimatedUsed: 450, estimatedRemaining: 550 })
    expect(JSON.parse(await readFile(join(directory, 'tier-budget.json'), 'utf8')).baselineUsed.high).toBe(100)
  })

  it('preserves the baseline and unresolved reserves across restart', async () => {
    const { budget, config, directory } = await fixture()
    const first = receipt(await reserve(budget, 'first', quota(day1, 1000, 2000, 200)))
    await budget.settle(first, { inputTokens: 50, outputTokens: 10 })
    const pending = receipt(await reserve(budget, 'pending', quota(day1, 1000, 2000, 260)))
    await budget.settle(pending)
    const restarted = new TierBudget(config)
    await reserve(restarted, 'new', quota(day1, 1000, 2000, 300))
    expect((await restarted.snapshot()).freePools?.high).toMatchObject({ officialUsed: 300, localCharged: 260, estimatedUsed: 500 })
    expect(JSON.parse(await readFile(join(directory, 'tier-budget.json'), 'utf8')).baselineUsed.high).toBe(200)
  })

  it('keeps official usage high water and never moves back after refund or a larger snapshot', async () => {
    const { budget } = await fixture()
    const high = receipt(await reserve(budget, 'high', quota(day1, 100)))
    expect(receipt(await reserve(budget, 'middle', quota(day1, 100, 2000, 50))).tier).toBe('middle')
    await budget.settle(high, { inputTokens: 1, outputTokens: 1 })
    expect(receipt(await reserve(budget, 'still-middle', quota(day1, 100_000, 2000, 0))).tier).toBe('middle')
    expect((await budget.snapshot()).freePools?.high?.officialUsed).toBe(50)
  })

  it('enters the paid tier only when the complete request fits neither free pool', async () => {
    const { budget } = await fixture()
    const r = receipt(await reserve(budget, 'paid', quota(day1, 99, 99)))
    expect(r.tier).toBe('paid')
    expect(r.reservedCostMicrousd).toBe(60)
    expect((await budget.snapshot()).paidDailyBudgetMicrousd).toBe(1_000_000)
    expect((await budget.snapshot()).paidRemainingMicrousd).toBe(999_940)
  })

  it('reserves a paid request at the exact budget boundary and blocks the next one', async () => {
    const { budget } = await fixture({ paidDailyBudgetMicrousd: 60 })
    expect(receipt(await reserve(budget, 'exact', quota(day1, 0, 0))).tier).toBe('paid')
    expect(await reserve(budget, 'blocked', quota(day1, 0, 0))).toMatchObject({ kind: 'human', reason: expect.stringContaining('paid-model daily budget') })
    expect((await budget.snapshot()).tiers.paid.reservedRequests).toBe(1)
    expect((await budget.pendingEvents()).filter(e => e.kind === 'paid-budget-exhausted')).toHaveLength(1)
    await reserve(budget, 'blocked-again', quota(day1, 0, 0))
    expect((await budget.pendingEvents()).filter(e => e.kind === 'paid-budget-exhausted')).toHaveLength(1)
  })

  it('can disable paid usage explicitly with a zero budget', async () => {
    const { budget } = await fixture({ paidDailyBudgetMicrousd: 0 })
    expect(await reserve(budget, 'blocked', quota(day1, 0, 0))).toMatchObject({ kind: 'human' })
    expect((await budget.snapshot()).tiers.paid.reservedRequests).toBe(0)
  })

  it('refuses unknown, stale, wrong-day or future snapshots even if paid is affordable', async () => {
    const { budget } = await fixture()
    const inputs = [undefined, { ...quota(), fetchedAt: day1 - 300_001 }, { ...quota(), day: '2026-10-10' }, { ...quota(), fetchedAt: day1 + 1 }]
    for (const [i, snapshot] of inputs.entries()) {
      expect(await budget.reserve({ attemptId: `unknown-${i}`, inputTokenUpperBound: 80, outputTokenLimit: 20, ...(snapshot ? { quota: snapshot } : {}) })).toMatchObject({ kind: 'human' })
    }
    expect((await budget.snapshot()).tiers.high.reservedRequests).toBe(0)
    expect((await budget.snapshot()).tiers.paid.reservedRequests).toBe(0)
  })

  it('rejects a newly-labelled day with a snapshot fetched before that day began', async () => {
    const { budget } = await fixture({ now: () => day2 + 60_000 })
    expect(await reserve(budget, 'wrong-date', { ...quota(day2), fetchedAt: day2 - 1 })).toMatchObject({ kind: 'human' })
  })

  it('uses the newest snapshot limits while preserving usage high water', async () => {
    let now = day1
    const { budget } = await fixture({ now: () => now })
    await reserve(budget, 'newer', quota(day1, 5000, 5000, 300))
    now += 100
    await reserve(budget, 'latest', quota(now, 6000, 6000, 100))
    await reserve(budget, 'older', quota(day1, 999999, 999999, 200))
    expect((await budget.snapshot()).freePools?.high).toMatchObject({ officialUsed: 300, limit: 6000 })
  })

  it('reports stale stored estimates without calling them a current balance', async () => {
    let now = day1
    const { budget } = await fixture({ now: () => now })
    await reserve(budget, 'first')
    now += 300_001
    expect((await budget.snapshot()).quotaStatus).toBe('stale')
    expect(await reserve(budget, 'second')).toMatchObject({ kind: 'human' })
  })

  it('establishes the persisted baseline from the first fresh UI snapshot', async () => {
    const { budget, directory, config } = await fixture()
    const first = await budget.snapshot(quota(day1, 1000, 2000, 250, 450))
    expect(first.freePools?.high).toMatchObject({ officialUsed: 250, localCharged: 0, estimatedUsed: 250, estimatedRemaining: 750 })
    const saved = JSON.parse(await readFile(join(directory, 'tier-budget.json'), 'utf8'))
    expect(saved.baselineUsed).toEqual({ high: 250, middle: 450 })
    expect(saved.attempts).toEqual({})
    const restarted = new TierBudget(config)
    await restarted.snapshot(quota(day1, 1000, 2000, 300, 500))
    expect(JSON.parse(await readFile(join(directory, 'tier-budget.json'), 'utf8')).baselineUsed).toEqual(saved.baselineUsed)
  })

  it('merges UI usage under the reservation lock and preserves all pending deductions', async () => {
    const { budget } = await fixture()
    await reserve(budget, 'pending', quota(day1, 1000, 2000, 100))
    const fresh = await budget.snapshot(quota(day1, 1000, 2000, 500))
    expect(fresh.freePools?.high).toMatchObject({ officialUsed: 500, localCharged: 100, estimatedUsed: 600, estimatedRemaining: 400 })
    // A stale UI or caller can never decrease the already observed high water.
    expect(receipt(await reserve(budget, 'exact', quota(day1, 1000, 2000, 100), 380, 20)).tier).toBe('high')
    expect((await budget.snapshot()).freePools?.high?.estimatedUsed).toBe(1000)
    expect(receipt(await reserve(budget, 'next', quota(day1, 1000, 2000, 100))).tier).toBe('middle')
  })

  it('ignores stale and future UI snapshots without inventing or resetting a baseline', async () => {
    const { budget, directory } = await fixture()
    expect((await budget.snapshot({ ...quota(), fetchedAt: day1 - 300_001 })).quotaStatus).toBe('unknown')
    expect(JSON.parse(await readFile(join(directory, 'tier-budget.json'), 'utf8')).baselineUsed).toBeNull()
    await budget.snapshot(quota(day1, 1000, 2000, 200))
    await budget.snapshot({ ...quota(day1, 9999, 9999, 9999), fetchedAt: day1 + 1 })
    expect((await budget.snapshot()).freePools?.high).toMatchObject({ officialUsed: 200, limit: 1000, estimatedUsed: 200 })
  })
})

describe('idempotence, persistence and pricing', () => {
  it('rejects replayed attempts across instances and restart without a second charge', async () => {
    const { budget, config } = await fixture()
    const r = receipt(await reserve(budget, 'one'))
    const restarted = new TierBudget(config)
    expect(await reserve(restarted, 'one')).toMatchObject({ kind: 'human', reason: expect.stringContaining('already reserved') })
    await restarted.settle(r, { inputTokens: 30, outputTokens: 10 })
    await restarted.settle(r, { inputTokens: 0, outputTokens: 0 })
    expect(await reserve(restarted, 'one')).toMatchObject({ kind: 'human' })
    expect((await restarted.snapshot()).tiers.high).toMatchObject({ tokens: 40, reservedRequests: 1, estimatedRetailCostMicrousd: 140 })
  })

  it('keeps unknown usage charged and never refunds it on a later duplicate settlement', async () => {
    const { budget, config } = await fixture()
    const unknown = receipt(await reserve(budget, 'unknown'))
    await budget.settle(unknown)
    await reserve(budget, 'crashed')
    const restarted = new TierBudget(config)
    await restarted.settle(unknown, { inputTokens: 0, outputTokens: 0 })
    expect((await restarted.snapshot()).tiers.high).toMatchObject({ tokens: 200, reservedRequests: 2, unresolvedRequests: 2, estimatedRetailCostMicrousd: 640 })
  })

  it('binds model and pricing to the reservation rather than later configuration', async () => {
    const { budget, config } = await fixture()
    const r = receipt(await reserve(budget, 'first'))
    const changed = new TierBudget({ ...config, tiers: { ...rates, high: { ...rates.high, model: 'gpt-new-fixture', inputMicrousdPerMillion: 900_000_000 } } })
    await changed.settle(r, { inputTokens: 30, outputTokens: 10 })
    expect((await changed.snapshot()).tiers.high.estimatedRetailCostMicrousd).toBe(140)
    await expect(changed.settle({ ...r, model: 'gpt-new-fixture' })).rejects.toThrow('does not match')
  })

  it('charges unexpected usage overruns before reporting an error', async () => {
    const { budget } = await fixture({ paidDailyBudgetMicrousd: 60 })
    const r = receipt(await reserve(budget, 'paid', quota(day1, 0, 0)))
    await expect(budget.settle(r, { inputTokens: 500, outputTokens: 500 })).rejects.toThrow('complete usage was recorded')
    expect((await budget.snapshot()).tiers.paid).toMatchObject({ tokens: 1000, estimatedRetailCostMicrousd: 750 })
    expect((await budget.snapshot()).paidRemainingMicrousd).toBe(0)
    expect(await reserve(budget, 'again', quota(day1, 0, 0))).toMatchObject({ kind: 'human' })
  })

  it('calculates integer micro-dollar ceilings without floating-point undercharges', () => {
    expect(estimateRetailCostMicrousd(1, 1, { model: 'gpt-fixture', inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 1 })).toBe(1)
    expect(estimateRetailCostMicrousd(1_000_000, 1_000_000, rates.high)).toBe(10_000_000)
    expect(() => estimateRetailCostMicrousd(1, 1, { ...rates.high, outputMicrousdPerMillion: 0 })).toThrow()
  })

  it('coordinates competing reservations and duplicate IDs across instances', async () => {
    const { config } = await fixture({ paidDailyBudgetMicrousd: 0 })
    const instances = Array.from({ length: 14 }, () => new TierBudget(config))
    const results = await Promise.all(instances.map((instance, i) => reserve(instance, `call-${Math.floor(i / 2)}`, quota(day1, 200, 300))))
    const accepted = results.filter(result => result.kind === 'reserved')
    expect(accepted.filter(result => result.reservation.tier === 'high')).toHaveLength(2)
    expect(accepted.filter(result => result.reservation.tier === 'middle')).toHaveLength(3)
    expect(accepted).toHaveLength(5)
    expect((await instances[0]!.snapshot()).tiers.paid.reservedRequests).toBe(0)
  })

  it('coordinates token pools across four independent Node processes', async () => {
    const { base, directory } = await fixture()
    const require = createRequire(import.meta.url)
    const zodFile = pathToFileURL(require.resolve('zod').replace(/\.cjs$/, '.js')).href
    const source = (await readFile(new URL('../src/tier-budget.ts', import.meta.url), 'utf8')).replace("from 'zod'", `from ${JSON.stringify(zodFile)}`)
    await writeFile(join(base, 'tier-budget.mjs'), transpileModule(source, { compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 } }).outputText)
    const code = `import { TierBudget } from ${JSON.stringify(pathToFileURL(join(base, 'tier-budget.mjs')).href)};
      const b = new TierBudget({directory: process.argv[1], tiers: ${JSON.stringify(rates)}, paidDailyBudgetMicrousd: 0, now: () => ${day1}});
      const results = [];
      for (let i = 0; i < 3; i++) { const r = await b.reserve({attemptId: process.argv[2]+'-'+i, inputTokenUpperBound: 80, outputTokenLimit: 20, quota: ${JSON.stringify(quota(day1, 200, 300))}}); if(r.kind === 'reserved') results.push(r.reservation.tier); }
      process.stdout.write(JSON.stringify(results));`
    const children = await Promise.all(Array.from({ length: 4 }, (_, i) => execute(process.execPath, ['--input-type=module', '-e', code, directory, `process-${i}`])))
    const tiers = children.flatMap(child => JSON.parse(child.stdout))
    expect(tiers.filter(t => t === 'high')).toHaveLength(2)
    expect(tiers.filter(t => t === 'middle')).toHaveLength(3)
    expect(tiers).toHaveLength(5)
  })

  it('resets at UTC midnight and never credits an old response to the new day', async () => {
    let now = day1
    const { budget } = await fixture({ now: () => now })
    const yesterday = receipt(await reserve(budget, 'yesterday', quota(day1, 0, 0)))
    now = day2
    const today = receipt(await reserve(budget, 'today', quota(day2)))
    expect(today.tier).toBe('high')
    await budget.settle(yesterday, { inputTokens: 0, outputTokens: 0 })
    expect((await budget.snapshot()).tiers.high.tokens).toBe(100)
    expect((await budget.snapshot()).tiers.paid.tokens).toBe(0)
    expect((await budget.pendingEvents()).some(event => event.kind === 'utc-reset')).toBe(true)
  })

  it('refuses clock rollback', async () => {
    let now = day2
    const { budget } = await fixture({ now: () => now })
    await reserve(budget, 'day2', quota(day2))
    now = day1
    await expect(reserve(budget, 'rollback')).rejects.toThrow('clock moved behind')
  })

  it('cannot replace a future persisted snapshot with an older snapshot after same-day clock rollback', async () => {
    let now = day1 + 1000
    const { budget } = await fixture({ now: () => now })
    await reserve(budget, 'first', quota(now))
    now = day1
    expect(await reserve(budget, 'rollback', quota(now))).toMatchObject({ kind: 'human' })
    expect((await budget.snapshot()).tiers.high.reservedRequests).toBe(1)
  })

  it('preserves transition notifications across restart until explicitly acknowledged', async () => {
    const { budget, config } = await fixture()
    const result = await reserve(budget, 'middle', quota(day1, 0))
    expect(result.events).toHaveLength(1)
    const restarted = new TierBudget(config)
    expect(await restarted.pendingEvents()).toEqual(result.events)
    await restarted.acknowledgeEvent(result.events[0]!.id)
    await restarted.acknowledgeEvent(result.events[0]!.id)
    expect(await restarted.pendingEvents()).toEqual([])
    await reserve(restarted, 'same-tier', quota(day1, 0))
    expect(await restarted.pendingEvents()).toEqual([])
  })

  it('keeps bounded history and a monotonic sequence through more than 512 unacknowledged daily events', async () => {
    let now = day1
    const { budget, config, directory } = await fixture({ now: () => now, paidDailyBudgetMicrousd: 0 })
    for (let i = 0; i < 180; i++) {
      now = day1 + i * 86_400_000
      expect(await reserve(budget, `day-${i}`, quota(now, 0, 0))).toMatchObject({ kind: 'human' })
    }
    const before = await budget.snapshot()
    expect(before.events).toHaveLength(32)
    expect(before.events.at(-1)!.sequence).toBeGreaterThan(512)
    expect(before.events.map(e => e.sequence)).toEqual([...before.events.map(e => e.sequence)].sort((a, b) => a - b))
    expect(new Set(before.events.map(e => e.sequence)).size).toBe(32)
    const persisted = JSON.parse(await readFile(join(directory, 'tier-budget.json'), 'utf8'))
    expect(persisted.nextEventSequence).toBe(before.events.at(-1)!.sequence + 1)
    now += 86_400_000
    const restarted = new TierBudget(config)
    const next = await restarted.snapshot(quota(now))
    expect(next.tier).toBe('high')
    expect(next.events).toHaveLength(32)
    expect(next.events.at(-1)).toMatchObject({ sequence: persisted.nextEventSequence, kind: 'utc-reset' })
    expect(receipt(await reserve(restarted, 'working-after-180-days', quota(now))).tier).toBe('high')
  }, 15_000)
})

describe('legacy usage and safe storage', () => {
  it('imports v0.2 token usage into only the middle pool and marks incomplete history', async () => {
    const { budget, directory } = await fixture()
    const old = new DailyBudget({ directory, dailyTokenLimit: 1000, now: () => day1 })
    const oldReceipt = await old.reserve(600)
    expect(receipt(await reserve(budget, 'new', quota(day1, 0, 650))).tier).toBe('paid')
    const s = await budget.snapshot()
    expect(s.legacyMiddleTokens).toBe(600)
    expect(s.legacyIncomplete).toBe(true)
    expect(s.legacyCostUnknown).toBe(true)
    expect(s.tiers.middle).toMatchObject({ tokens: 600, reservedRequests: 0, estimatedRetailCostMicrousd: 0 })
    expect(s.tiers.high.tokens).toBe(0)
    await old.settle(oldReceipt, 50)
    expect((await budget.snapshot()).legacyMiddleTokens).toBe(600)
    await old.reserve(700)
    expect((await budget.snapshot()).legacyMiddleTokens).toBe(750)
    expect((await budget.pendingEvents()).filter(event => event.kind === 'legacy-import')).toHaveLength(1)
  })

  it('does not import yesterday legacy usage into today', async () => {
    const { budget, directory } = await fixture({ now: () => day2 })
    await new DailyBudget({ directory, dailyTokenLimit: 1000, now: () => day1 }).reserve(900)
    expect((await budget.snapshot()).legacyMiddleTokens).toBe(0)
  })

  it.each(['{invalid', '{"version":2}', '{"version":1,"day":"2026-10-11","floor":"paid"}'])('fails closed on corrupt state: %s', async content => {
    const { budget, directory } = await fixture()
    await budget.snapshot()
    await writeFile(join(directory, 'tier-budget.json'), content, { mode: 0o600 })
    await expect(reserve(budget, 'one')).rejects.toThrow()
    expect(await readFile(join(directory, 'tier-budget.json'), 'utf8')).toBe(content)
  })

  it('refuses corrupt legacy usage instead of silently starting over', async () => {
    const { budget, directory } = await fixture()
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, 'daily-budget.json'), 'broken legacy state', { mode: 0o600 })
    await expect(reserve(budget, 'one')).rejects.toThrow('corrupt ledger JSON')
  })

  it('rejects an inconsistent tier floor instead of moving back to a higher tier', async () => {
    const { budget, directory } = await fixture()
    await reserve(budget, 'paid', quota(day1, 0, 0))
    const path = join(directory, 'tier-budget.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.floor = 'high'
    await writeFile(path, JSON.stringify(saved), { mode: 0o600 })
    await expect(reserve(budget, 'another')).rejects.toThrow('invalid ledger reservation')
  })

  it.each(['symbolic', 'hard'])('rejects a %s linked ledger and leaves its target untouched', async kind => {
    const { budget, directory, base } = await fixture()
    await budget.snapshot()
    await rm(join(directory, 'tier-budget.json'))
    const target = join(base, 'untouched')
    await writeFile(target, 'original', { mode: 0o600 })
    if (kind === 'symbolic') await symlink(target, join(directory, 'tier-budget.json'))
    else await link(target, join(directory, 'tier-budget.json'))
    await expect(reserve(budget, 'one')).rejects.toThrow('regular files')
    expect(await readFile(target, 'utf8')).toBe('original')
  })

  it('rejects aliased parents and nonprivate storage', async () => {
    const { budget, directory, base, config } = await fixture()
    await budget.snapshot()
    const alias = join(base, 'alias')
    await symlink(directory, alias)
    await expect(new TierBudget({ ...config, directory: alias }).snapshot()).rejects.toThrow('symbolic link')
    await chmod(directory, 0o755)
    await expect(budget.snapshot()).rejects.toThrow('mode 0700')
    await chmod(directory, 0o700)
    await chmod(join(directory, 'tier-budget.json'), 0o644)
    await expect(budget.snapshot()).rejects.toThrow('mode 0600')
  })

  it('fails within a bounded wait without deleting an abandoned lock', async () => {
    const { budget, directory } = await fixture()
    await budget.snapshot()
    await writeFile(join(directory, 'daily-budget.lock'), 'abandoned', { mode: 0o600 })
    const start = performance.now()
    await expect(reserve(budget, 'one')).rejects.toThrow('ledger is locked')
    expect(performance.now() - start).toBeLessThan(1800)
    expect(await readFile(join(directory, 'daily-budget.lock'), 'utf8')).toBe('abandoned')
  })

  it('does not issue a receipt or lose previous charges when atomic persistence fails', async () => {
    const { budget, directory } = await fixture()
    await reserve(budget, 'first')
    faults.rename = true
    await expect(reserve(budget, 'failed')).rejects.toThrow('fixture disk failure')
    faults.rename = false
    expect((await budget.snapshot()).tiers.high.reservedRequests).toBe(1)
    expect(await readdir(directory)).toEqual(['tier-budget.json'])
    expect(receipt(await reserve(budget, 'failed')).tier).toBe('high')
  })

  it('does not refund a reservation when settlement persistence fails', async () => {
    const { budget } = await fixture()
    const r = receipt(await reserve(budget, 'first'))
    faults.rename = true
    await expect(budget.settle(r, { inputTokens: 1, outputTokens: 1 })).rejects.toThrow('fixture disk failure')
    faults.rename = false
    expect((await budget.snapshot()).tiers.high.tokens).toBe(100)
    await budget.settle(r, { inputTokens: 1, outputTokens: 1 })
    expect((await budget.snapshot()).tiers.high.tokens).toBe(2)
  })
})
