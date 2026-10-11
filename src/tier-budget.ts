import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'

export type TierId = 'high' | 'middle' | 'paid'
export interface TierConfig { model: string; inputMicrousdPerMillion: number; outputMicrousdPerMillion: number }
export interface TierQuotaSnapshot {
  day: string
  fetchedAt: number
  pools: { high: { used: number; limit: number }; middle: { used: number; limit: number } }
}
export interface TierBudgetOptions {
  directory: string
  tiers: Record<TierId, TierConfig>
  paidDailyBudgetMicrousd?: number
  quotaMaxAgeMs?: number
  /** Must share the budget directory and lock with the previous v0.2 ledger. */
  legacyBudgetFile?: string
  now?: () => number
}
export interface TierReservation {
  id: string
  attemptId: string
  day: string
  tier: TierId
  model: string
  reservedInputTokens: number
  reservedOutputTokens: number
  reservedTokens: number
  reservedCostMicrousd: number
  inputMicrousdPerMillion: number
  outputMicrousdPerMillion: number
}
export interface TierUsage { inputTokens: number; outputTokens: number }
export interface TierEvent {
  id: string
  sequence: number
  day: string
  createdAt: number
  kind: 'tier-switch' | 'paid-budget-exhausted' | 'utc-reset' | 'legacy-import'
  from: TierId
  to: TierId
  reason: string
}
export interface TierBudgetSnapshot {
  day: string
  tier: TierId
  quotaStatus: 'fresh' | 'stale' | 'unknown'
  quotaFetchedAt: number | null
  tiers: Record<TierId, { tokens: number; estimatedRetailCostMicrousd: number; reservedRequests: number; unresolvedRequests: number }>
  freePools: { high: PoolEstimate; middle: PoolEstimate } | null
  paidDailyBudgetMicrousd: number
  paidRemainingMicrousd: number
  legacyMiddleTokens: number
  legacyIncomplete: boolean
  legacyCostUnknown: boolean
  events: TierEvent[]
}
export interface PoolEstimate { officialUsed: number; localCharged: number; limit: number; estimatedUsed: number; estimatedRemaining: number }
export type TierReserveResult =
  | { kind: 'reserved'; reservation: TierReservation; events: TierEvent[] }
  | { kind: 'human'; reason: string; events: TierEvent[] }

const ORDER = ['high', 'middle', 'paid'] as const
const FILE = 'tier-budget.json'
// Shared with v0.2 so importing or refreshing its ledger cannot race an old writer.
const LOCK = 'daily-budget.lock'
const MAX_BYTES = 4 * 1024 * 1024
const MAX_ATTEMPTS = 10_000
const MAX_EVENTS = 32
const MAX_TOKENS = 10_000_000
const MAX_MONEY = 1_000_000_000 // $1,000 daily is an implementation ceiling, not a default.
const MAX_RATE = 1_000_000_000 // $1,000 per million tokens.
const ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
function fail(reason: string): never { throw new Error(`Safe Review tier budget: ${reason}`) }
const errno = (error: unknown, code: string): boolean => (error as NodeJS.ErrnoException)?.code === code
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino
function dayValid(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const daySchema = z.string().refine(dayValid)
const tierSchema = z.enum(ORDER)
const rateSchema = amount.min(1).max(MAX_RATE)
const configSchema = z.object({ model: z.string().regex(/^gpt-[A-Za-z0-9.-]{1,80}$/), inputMicrousdPerMillion: rateSchema, outputMicrousdPerMillion: rateSchema }).strict()
const quotaSchema = z.object({
  day: daySchema, fetchedAt: amount,
  pools: z.object({ high: z.object({ used: amount, limit: amount }).strict(), middle: z.object({ used: amount, limit: amount }).strict() }).strict(),
}).strict()
const receiptSchema = z.object({
  id: z.string().regex(UUID), attemptId: z.string().regex(ATTEMPT), day: daySchema, tier: tierSchema,
  model: configSchema.shape.model,
  reservedInputTokens: amount.max(MAX_TOKENS), reservedOutputTokens: amount.max(MAX_TOKENS),
  reservedTokens: amount.max(MAX_TOKENS), reservedCostMicrousd: amount,
  inputMicrousdPerMillion: rateSchema, outputMicrousdPerMillion: rateSchema,
}).strict()
const usageSchema = z.object({ inputTokens: amount, outputTokens: amount }).strict()
const eventSchema = z.object({
  id: z.string().regex(UUID), sequence: amount.min(1), day: daySchema, createdAt: amount,
  kind: z.enum(['tier-switch', 'paid-budget-exhausted', 'utc-reset', 'legacy-import']),
  from: tierSchema, to: tierSchema, reason: z.string().min(1).max(300),
}).strict()
const attemptSchema = z.object({ receipt: receiptSchema, status: z.enum(['pending', 'unknown', 'settled']), usage: usageSchema.nullable() }).strict()
const ledgerSchema = z.object({
  version: z.literal(1), day: daySchema, floor: tierSchema,
  official: quotaSchema.nullable(), legacyMiddleTokens: amount,
  baselineUsed: z.object({ high: amount, middle: amount }).strict().nullable(),
  paidExhaustionNotified: z.boolean(),
  nextEventSequence: amount.min(1),
  attempts: z.record(z.string().regex(ATTEMPT), attemptSchema),
  events: z.array(eventSchema).max(MAX_EVENTS),
}).strict()
type Ledger = z.infer<typeof ledgerSchema>

/** Conservative retail exposure; ignores free-token and cache discounts. */
export function estimateRetailCostMicrousd(inputTokens: number, outputTokens: number, rate: TierConfig): number {
  if (!integer(inputTokens) || !integer(outputTokens) || !configSchema.safeParse({ model: rate.model, inputMicrousdPerMillion: rate.inputMicrousdPerMillion, outputMicrousdPerMillion: rate.outputMicrousdPerMillion }).success) fail('invalid usage or pricing')
  const numerator = BigInt(inputTokens) * BigInt(rate.inputMicrousdPerMillion)
    + BigInt(outputTokens) * BigInt(rate.outputMicrousdPerMillion)
  const result = Number((numerator + 999_999n) / 1_000_000n)
  if (!integer(result)) fail('cost cannot be represented safely')
  return result
}
function privateFile(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600
    || (process.getuid && info.uid !== process.getuid())) fail('files must be privately owned regular files with mode 0600 and one link')
}
function sums(ledger: Ledger): TierBudgetSnapshot['tiers'] {
  const totals: TierBudgetSnapshot['tiers'] = {
    high: { tokens: 0, estimatedRetailCostMicrousd: 0, reservedRequests: 0, unresolvedRequests: 0 },
    middle: { tokens: ledger.legacyMiddleTokens, estimatedRetailCostMicrousd: 0, reservedRequests: 0, unresolvedRequests: 0 },
    paid: { tokens: 0, estimatedRetailCostMicrousd: 0, reservedRequests: 0, unresolvedRequests: 0 },
  }
  for (const entry of Object.values(ledger.attempts)) {
    const receipt = entry.receipt
    const total = totals[receipt.tier]
    total.tokens += entry.usage ? entry.usage.inputTokens + entry.usage.outputTokens : receipt.reservedTokens
    total.estimatedRetailCostMicrousd += entry.usage ? estimateRetailCostMicrousd(entry.usage.inputTokens, entry.usage.outputTokens, receipt) : receipt.reservedCostMicrousd
    total.reservedRequests++
    if (entry.status !== 'settled') total.unresolvedRequests++
    if (!integer(total.tokens) || !integer(total.estimatedRetailCostMicrousd)) fail('ledger totals are too large')
  }
  return totals
}

/** Reporting-lag estimate: settled local usage is not deducted twice. */
function poolEstimate(ledger: Ledger, pool: 'high' | 'middle'): PoolEstimate {
  if (!ledger.official || !ledger.baselineUsed) fail('pool estimate has no verified baseline')
  let settled = pool === 'middle' ? ledger.legacyMiddleTokens : 0
  let unresolved = 0
  for (const entry of Object.values(ledger.attempts)) {
    if (entry.receipt.tier !== pool) continue
    if (entry.usage) settled += entry.usage.inputTokens + entry.usage.outputTokens
    else unresolved += entry.receipt.reservedTokens
  }
  const officialUsed = ledger.official.pools[pool].used
  const localCharged = settled + unresolved
  const baselineAndSettled = ledger.baselineUsed[pool] + settled
  const estimatedUsed = Math.max(officialUsed, baselineAndSettled) + unresolved
  if (![settled, unresolved, localCharged, baselineAndSettled, estimatedUsed].every(integer)) fail('pool estimate is too large')
  const limit = ledger.official.pools[pool].limit
  return { officialUsed, localCharged, limit, estimatedUsed, estimatedRemaining: Math.max(0, limit - estimatedUsed) }
}

/** A conservative local routing estimate; this is never an official free balance. */
export class TierBudget {
  readonly directory: string
  readonly paidDailyBudgetMicrousd: number
  private readonly tiers: Record<TierId, TierConfig>
  private readonly now: () => number
  private readonly quotaMaxAgeMs: number
  private readonly legacyFile: string

  constructor(options: TierBudgetOptions) {
    if (!options.directory || !isAbsolute(options.directory) || options.directory.includes('\0')) fail('directory must be absolute')
    this.directory = resolve(options.directory)
    this.tiers = z.object({ high: configSchema, middle: configSchema, paid: configSchema }).strict().parse(options.tiers)
    this.paidDailyBudgetMicrousd = options.paidDailyBudgetMicrousd ?? 1_000_000
    this.quotaMaxAgeMs = options.quotaMaxAgeMs ?? 300_000
    if (!integer(this.paidDailyBudgetMicrousd) || this.paidDailyBudgetMicrousd > MAX_MONEY) fail('invalid paid daily budget')
    if (!integer(this.quotaMaxAgeMs) || this.quotaMaxAgeMs < 1000 || this.quotaMaxAgeMs > 3_600_000) fail('invalid quota snapshot lifetime')
    this.legacyFile = options.legacyBudgetFile ?? join(this.directory, 'daily-budget.json')
    if (!isAbsolute(this.legacyFile) || dirname(resolve(this.legacyFile)) !== this.directory || resolve(this.legacyFile) === join(this.directory, FILE)) fail('legacy ledger must share the same private directory and lock')
    this.now = options.now ?? Date.now
  }

  async reserve(input: { attemptId: string; inputTokenUpperBound: number; outputTokenLimit: number; quota?: TierQuotaSnapshot }): Promise<TierReserveResult> {
    if (typeof input.attemptId !== 'string' || !ATTEMPT.test(input.attemptId) || !integer(input.inputTokenUpperBound) || !integer(input.outputTokenLimit)
      || input.inputTokenUpperBound < 1 || input.outputTokenLimit < 1 || input.inputTokenUpperBound + input.outputTokenLimit > MAX_TOKENS) fail('invalid request estimate')
    return this.transaction(ledger => {
      const human = (reason: string): TierReserveResult => ({ kind: 'human', reason, events: structuredClone(ledger.events) })
      if (Object.hasOwn(ledger.attempts, input.attemptId)) return human('This review attempt was already reserved; automatic retries are blocked.')
      if (Object.keys(ledger.attempts).length >= MAX_ATTEMPTS) return human('The daily review record limit was reached.')
      if (!this.mergeQuota(ledger, input.quota)) return human('A current official UTC quota snapshot is required; remaining free tokens are unknown.')
      const totals = sums(ledger)
      const tokens = input.inputTokenUpperBound + input.outputTokenLimit
      let selected: TierId = 'paid'
      for (const tier of ORDER.slice(ORDER.indexOf(ledger.floor))) {
        if (tier === 'paid') break
        const pool = poolEstimate(ledger, tier)
        // Pending/unknown reservations stay fully charged. Settled local tokens
        // overlap the official report; external concurrent usage can still lag.
        if (tokens <= pool.estimatedRemaining) { selected = tier; break }
      }
      if (selected !== ledger.floor) {
        this.event(ledger, 'tier-switch', ledger.floor, selected, 'The complete request no longer fits the conservative free-pool estimate.')
        ledger.floor = selected
      }
      const rate = this.tiers[selected]
      const cost = estimateRetailCostMicrousd(input.inputTokenUpperBound, input.outputTokenLimit, rate)
      if (selected === 'paid' && (this.paidDailyBudgetMicrousd === 0 || totals.paid.estimatedRetailCostMicrousd > this.paidDailyBudgetMicrousd
        || cost > this.paidDailyBudgetMicrousd - totals.paid.estimatedRetailCostMicrousd)) {
        if (!ledger.paidExhaustionNotified) {
          this.event(ledger, 'paid-budget-exhausted', 'paid', 'paid', 'The complete request exceeds the configured local paid-model budget; human confirmation is required.')
          ledger.paidExhaustionNotified = true
        }
        return human('The configured local paid-model daily budget cannot fit this request.')
      }
      const reservation: TierReservation = {
        id: randomUUID(), attemptId: input.attemptId, day: ledger.day, tier: selected, model: rate.model,
        reservedInputTokens: input.inputTokenUpperBound, reservedOutputTokens: input.outputTokenLimit,
        reservedTokens: tokens, reservedCostMicrousd: cost,
        inputMicrousdPerMillion: rate.inputMicrousdPerMillion, outputMicrousdPerMillion: rate.outputMicrousdPerMillion,
      }
      ledger.attempts[input.attemptId] = { receipt: reservation, status: 'pending', usage: null }
      return { kind: 'reserved', reservation: structuredClone(reservation), events: structuredClone(ledger.events) }
    })
  }

  async settle(receipt: TierReservation, usage?: TierUsage): Promise<void> {
    const checked = receiptSchema.safeParse(receipt)
    if (!checked.success || (usage !== undefined && !usageSchema.safeParse(usage).success)) fail('invalid settlement')
    const overrun = await this.transaction(ledger => {
      if (receipt.day < ledger.day) return false
      if (receipt.day !== ledger.day) fail('receipt belongs to a future UTC day')
      const entry = Object.hasOwn(ledger.attempts, receipt.attemptId) ? ledger.attempts[receipt.attemptId] : undefined
      if (!entry || JSON.stringify(entry.receipt) !== JSON.stringify(checked.data)) fail('receipt does not match the ledger')
      if (entry.status !== 'pending') return false
      if (usage === undefined) { entry.status = 'unknown'; return false }
      const cost = estimateRetailCostMicrousd(usage.inputTokens, usage.outputTokens, entry.receipt)
      if (!integer(usage.inputTokens + usage.outputTokens)) fail('invalid usage total')
      entry.status = 'settled'
      entry.usage = { ...usage }
      sums(ledger)
      return usage.inputTokens + usage.outputTokens > receipt.reservedTokens || cost > receipt.reservedCostMicrousd
    })
    if (overrun) fail('actual usage exceeded the reservation; the complete usage was recorded')
  }

  async snapshot(quota?: TierQuotaSnapshot): Promise<TierBudgetSnapshot> {
    return this.transaction(ledger => {
      if (quota !== undefined) this.mergeQuota(ledger, quota)
      const totals = sums(ledger)
      return {
        day: ledger.day, tier: ledger.floor,
        quotaStatus: ledger.official ? this.fresh(ledger.official, ledger.day) ? 'fresh' : 'stale' : 'unknown',
        quotaFetchedAt: ledger.official?.fetchedAt ?? null,
        tiers: totals, freePools: ledger.official ? { high: poolEstimate(ledger, 'high'), middle: poolEstimate(ledger, 'middle') } : null,
        paidDailyBudgetMicrousd: this.paidDailyBudgetMicrousd,
        paidRemainingMicrousd: Math.max(0, this.paidDailyBudgetMicrousd - totals.paid.estimatedRetailCostMicrousd),
        legacyMiddleTokens: ledger.legacyMiddleTokens, legacyIncomplete: ledger.legacyMiddleTokens > 0, legacyCostUnknown: ledger.legacyMiddleTokens > 0,
        events: structuredClone(ledger.events),
      }
    })
  }
  async pendingEvents(): Promise<TierEvent[]> { return this.transaction(ledger => structuredClone(ledger.events)) }
  async acknowledgeEvent(id: string): Promise<void> {
    if (!UUID.test(id)) fail('invalid event receipt')
    await this.transaction(ledger => { ledger.events = ledger.events.filter(event => event.id !== id) })
  }

  private timestamp(): number {
    const now = this.now()
    if (!integer(now) || !Number.isFinite(new Date(now).valueOf())) fail('invalid clock')
    return now
  }
  private fresh(snapshot: TierQuotaSnapshot, day: string): boolean {
    const now = this.timestamp()
    return snapshot.day === day && snapshot.fetchedAt <= now && now - snapshot.fetchedAt <= this.quotaMaxAgeMs
      && new Date(snapshot.fetchedAt).toISOString().slice(0, 10) === day
  }
  /** Both UI snapshots and reservations observe exactly the same atomic estimate. */
  private mergeQuota(ledger: Ledger, quota: TierQuotaSnapshot | undefined): boolean {
    const parsed = quotaSchema.safeParse(quota)
    if (!parsed.success || !this.fresh(parsed.data, ledger.day)) return false
    const incoming = parsed.data
    const previous = ledger.official
    const latest = previous && previous.fetchedAt > incoming.fetchedAt ? previous : incoming
    const merged = structuredClone(latest)
    for (const pool of ['high', 'middle'] as const) merged.pools[pool].used = Math.max(incoming.pools[pool].used, previous?.pools[pool].used ?? 0)
    if (!this.fresh(merged, ledger.day)) return false
    ledger.official = merged
    // The first new-day observation, including a UI read, establishes the
    // persisted baseline. Later observations cannot count settled tokens twice.
    ledger.baselineUsed ??= { high: incoming.pools.high.used, middle: Math.max(0, incoming.pools.middle.used - ledger.legacyMiddleTokens) }
    return true
  }
  private event(ledger: Ledger, kind: TierEvent['kind'], from: TierId, to: TierId, reason: string): void {
    if (!integer(ledger.nextEventSequence + 1)) fail('event sequence cannot be represented safely')
    ledger.events.push({ id: randomUUID(), sequence: ledger.nextEventSequence++, day: ledger.day, createdAt: this.timestamp(), kind, from, to, reason })
    // This is bounded persistent history, not an indefinitely growing outbox.
    if (ledger.events.length > MAX_EVENTS) ledger.events.splice(0, ledger.events.length - MAX_EVENTS)
  }
  private validate(value: unknown): Ledger {
    const parsed = ledgerSchema.safeParse(value)
    if (!parsed.success) fail('corrupt ledger; refusing to reset usage')
    const ledger = parsed.data
    if (Object.keys(ledger.attempts).length > MAX_ATTEMPTS || (ledger.official && (ledger.official.day !== ledger.day
      || !Number.isFinite(new Date(ledger.official.fetchedAt).valueOf())
      || new Date(ledger.official.fetchedAt).toISOString().slice(0, 10) !== ledger.day))) fail('invalid ledger state')
    if ((ledger.official === null) !== (ledger.baselineUsed === null)
      || (ledger.official && ledger.baselineUsed && (ledger.baselineUsed.high > ledger.official.pools.high.used
        || ledger.baselineUsed.middle > ledger.official.pools.middle.used))) fail('invalid quota baseline')
    const ids = new Set<string>()
    for (const [attemptId, entry] of Object.entries(ledger.attempts)) {
      const receipt = entry.receipt
      if (receipt.attemptId !== attemptId || receipt.day !== ledger.day || ids.has(receipt.id) || ORDER.indexOf(receipt.tier) > ORDER.indexOf(ledger.floor)
        || receipt.reservedTokens !== receipt.reservedInputTokens + receipt.reservedOutputTokens
        || receipt.reservedInputTokens < 1 || receipt.reservedOutputTokens < 1
        || receipt.reservedCostMicrousd !== estimateRetailCostMicrousd(receipt.reservedInputTokens, receipt.reservedOutputTokens, receipt)
        || (entry.status === 'settled') !== (entry.usage !== null)) fail('invalid ledger reservation')
      ids.add(receipt.id)
    }
    if (new Set(ledger.events.map(event => event.id)).size !== ledger.events.length
      || ledger.events.some((event, index) => event.sequence >= ledger.nextEventSequence
        || (index > 0 && event.sequence <= ledger.events[index - 1]!.sequence))) fail('invalid notification event sequence')
    sums(ledger)
    return ledger
  }
  private async importLegacy(ledger: Ledger): Promise<void> {
    const value = await this.readJson(this.legacyFile)
    if (value === undefined) return
    const legacySchema = z.object({ version: z.literal(1), day: daySchema, charged: amount, pending: z.record(z.string().regex(UUID), amount) }).strict()
    const parsed = legacySchema.safeParse(value)
    if (!parsed.success) fail('legacy ledger is corrupt; refusing to discard its usage')
    const legacy = parsed.data
    if (Object.values(legacy.pending).some(n => n < 1) || Object.values(legacy.pending).reduce((sum, n) => sum + n, 0) > legacy.charged) fail('legacy ledger total is invalid')
    if (legacy.day > ledger.day) fail('clock moved behind the legacy ledger')
    if (legacy.day === ledger.day && legacy.charged > ledger.legacyMiddleTokens) {
      if (ledger.legacyMiddleTokens === 0) this.event(ledger, 'legacy-import', ledger.floor, ledger.floor, 'Previous-version token usage was conservatively assigned to the middle pool; its model and cost history are incomplete.')
      ledger.legacyMiddleTokens = legacy.charged
    }
  }
  private async directoryInfo(create: boolean): Promise<Stats> {
    const root = parse(this.directory).root
    let path = root
    let info = await lstat(path)
    const components = this.directory.slice(root.length).split(sep).filter(Boolean)
    if (!components.length) fail('the filesystem root cannot be a budget directory')
    for (const component of components) {
      path = join(path, component)
      try { info = await lstat(path) } catch (error) {
        if (!create || !errno(error, 'ENOENT')) throw error
        try { await mkdir(path, { mode: 0o700 }) } catch (mkdirError) { if (!errno(mkdirError, 'EEXIST')) throw mkdirError }
        info = await lstat(path)
      }
      if (!info.isDirectory() || info.isSymbolicLink() || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) fail('unsafe directory path or symbolic link')
    }
    if ((info.mode & 0o7777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) fail('budget directory must be private with mode 0700')
    return info
  }
  private async checkDirectory(expected: Stats): Promise<void> { if (!same(expected, await this.directoryInfo(false))) fail('budget directory changed') }
  private async lock(directory: Stats): Promise<FileHandle> {
    const path = join(this.directory, LOCK)
    for (let attempt = 0; attempt <= 25; attempt++) {
      await this.checkDirectory(directory)
      try {
        const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try { privateFile(await handle.stat()); return handle } catch (error) { await handle.close(); throw error }
      } catch (error) {
        if (!errno(error, 'EEXIST')) throw error
        try { privateFile(await lstat(path)) } catch (statError) { if (errno(statError, 'ENOENT')) continue; throw statError }
        if (attempt === 25) fail('ledger is locked; abandoned locks require manual inspection')
        await delay(20)
      }
    }
    return fail('unable to acquire ledger lock')
  }
  private async readJson(path: string): Promise<unknown> {
    let before: Stats
    try { before = await lstat(path) } catch (error) { if (errno(error, 'ENOENT')) return undefined; throw error }
    privateFile(before)
    if (before.size > MAX_BYTES) fail('ledger exceeds size limit')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat()
      privateFile(opened)
      if (!same(before, opened)) fail('ledger changed while opening')
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const after = await handle.stat()
      privateFile(after)
      if (bytesRead > MAX_BYTES || after.size !== bytesRead || !same(opened, await lstat(path))) fail('ledger changed while reading')
      try { return JSON.parse(buffer.toString('utf8', 0, bytesRead)) as unknown } catch { return fail('corrupt ledger JSON; refusing to reset usage') }
    } finally { await handle.close() }
  }
  private async write(ledger: Ledger, directory: Stats): Promise<void> {
    const text = `${JSON.stringify(ledger)}\n`
    if (Buffer.byteLength(text) > MAX_BYTES) fail('ledger exceeds size limit')
    const temporary = join(this.directory, `.tier-budget-${randomUUID()}.tmp`)
    await this.checkDirectory(directory)
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    const identity = await handle.stat()
    let moved = false
    try {
      privateFile(identity)
      await handle.writeFile(text, 'utf8'); await handle.sync()
      await this.checkDirectory(directory)
      try { privateFile(await lstat(join(this.directory, FILE))) } catch (error) { if (!errno(error, 'ENOENT')) throw error }
      await rename(temporary, join(this.directory, FILE))
      moved = true
      const parent = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { if (!same(directory, await parent.stat())) fail('directory changed during persistence'); await parent.sync() }
      finally { await parent.close() }
    } finally {
      await handle.close()
      if (!moved) {
        await this.checkDirectory(directory)
        try {
          const current = await lstat(temporary)
          privateFile(current)
          if (!same(identity, current)) fail('temporary ledger changed; refusing to remove it')
          await unlink(temporary)
        } catch (error) { if (!errno(error, 'ENOENT')) throw error }
      }
    }
  }
  private async transaction<T>(action: (ledger: Ledger) => T): Promise<T> {
    const directory = await this.directoryInfo(true)
    const lock = await this.lock(directory)
    const identity = await lock.stat()
    try {
      await this.checkDirectory(directory)
      const day = new Date(this.timestamp()).toISOString().slice(0, 10)
      if (!dayValid(day)) fail('invalid UTC day')
      const raw = await this.readJson(join(this.directory, FILE))
      let ledger = raw === undefined ? undefined : this.validate(raw)
      if (ledger && ledger.day > day) fail('clock moved behind the ledger day')
      const before = JSON.stringify(ledger)
      if (!ledger || ledger.day !== day) {
        const previous = ledger
        ledger = { version: 1, day, floor: 'high', official: null, baselineUsed: null, legacyMiddleTokens: 0, paidExhaustionNotified: false, nextEventSequence: previous?.nextEventSequence ?? 1, attempts: {}, events: previous?.events ?? [] }
        if (previous) this.event(ledger, 'utc-reset', previous.floor, 'high', 'A new UTC day starts with the high tier and new local budgets.')
      }
      await this.importLegacy(ledger)
      const result = action(ledger)
      this.validate(ledger)
      if (before !== JSON.stringify(ledger)) await this.write(ledger, directory)
      return result
    } finally {
      await lock.close()
      await this.checkDirectory(directory)
      const current = await lstat(join(this.directory, LOCK))
      privateFile(current)
      if (!same(identity, current)) fail('lock changed; refusing to remove it')
      await unlink(join(this.directory, LOCK))
    }
  }
}
