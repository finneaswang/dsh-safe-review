/** Public accounting DTO. This boundary never carries prompts, tool arguments or credentials. */
import { z } from 'zod'

export const SAFE_REVIEW_PACKAGE = '@finneas/dsh-safe-review'
export const tierIdSchema = z.enum(['free-primary', 'free-secondary', 'paid'])
export type UsageTierId = z.infer<typeof tierIdSchema>
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const instant = z.number().int().nonnegative().max(8_640_000_000_000_000)
const money = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
const billedMoney = z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)

const tierSchema = z.object({
  id: tierIdSchema,
  model: z.string().regex(/^gpt-[A-Za-z0-9.-]{1,80}$/),
  /** Tokens measured by this plugin, regardless of other users of the account. */
  localUsedTokens: count,
  /** A free allowance is null for the paid tier. Unknown amounts remain null. */
  allowance: z.object({
    limitTokens: count.nullable(),
    usedTokens: count.nullable(),
    remainingTokens: count.nullable(),
    source: z.enum(['official', 'local-estimate', 'unknown']),
    updatedAt: instant.nullable(),
    /** Official Usage API observation, separate from the conservative routing estimate. */
    officialUsedTokens: count.nullable().optional(),
    officialUsageUpdatedAt: instant.nullable().optional(),
  }).nullable(),
  /** Estimate using configured prices; null means no reliable price is available. */
  estimatedCostUsd: money.nullable(),
})

export const usageSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['ready', 'unavailable', 'disabled']),
  updatedAt: instant,
  resetsAt: instant.nullable(),
  activeTier: tierIdSchema.nullable(),
  tiers: z.array(tierSchema).max(3),
  /** Plugin spending cap, distinct from the account's prepaid balance. */
  paidBudget: z.object({ limitUsd: money, estimatedUsedUsd: money, remainingUsd: money }).nullable(),
  accountCosts: z.object({
    todayUsd: billedMoney.nullable(), monthUsd: billedMoney.nullable(), updatedAt: instant,
    source: z.literal('official-costs'),
  }).nullable(),
  accountCredit: z.object({
    balanceUsd: money.nullable(), source: z.enum(['manual-baseline', 'unknown']), updatedAt: instant.nullable(),
  }),
  lastSwitch: z.object({
    sequence: count,
    at: instant,
    from: tierIdSchema.nullable(),
    to: tierIdSchema,
    reason: z.enum(['free-exhausted', 'daily-reset', 'configured', 'service-unavailable', 'paid-budget-exhausted']),
  }).nullable(),
}).superRefine((snapshot, ctx) => {
  const ids = snapshot.tiers.map(tier => tier.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Duplicate usage tier.' })
  if (snapshot.status === 'ready' && (ids.length !== 3 || snapshot.activeTier === null)) {
    ctx.addIssue({ code: 'custom', message: 'Ready usage requires three tiers and an active tier.' })
  }
  if (snapshot.accountCredit.source === 'unknown' && snapshot.accountCredit.balanceUsd !== null) {
    ctx.addIssue({ code: 'custom', message: 'Unknown account credit cannot advertise a balance.' })
  }
  for (const tier of snapshot.tiers) {
    if (tier.id === 'paid' && tier.allowance !== null) {
      ctx.addIssue({ code: 'custom', message: 'Paid tier cannot advertise a free allowance.' })
    }
    if (tier.allowance?.source === 'unknown'
      && (tier.allowance.remainingTokens !== null || tier.allowance.usedTokens !== null)) {
      ctx.addIssue({ code: 'custom', message: 'Unknown allowance cannot advertise a balance.' })
    }
  }
})

export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>
export type UsageTier = UsageSnapshot['tiers'][number]
export type UsageSwitch = NonNullable<UsageSnapshot['lastSwitch']>

/** Deliberately generic: exception strings can contain paths, prompts or keys. */
export function unavailableUsageSnapshot(now = Date.now()): UsageSnapshot {
  return { schemaVersion: 1, status: 'unavailable', updatedAt: now, resetsAt: null,
    activeTier: null, tiers: [], paidBudget: null, accountCosts: null,
    accountCredit: { balanceUsd: null, source: 'unknown', updatedAt: null }, lastSwitch: null }
}

/** Strip undeclared fields recursively and detach every object before crossing RPC. */
export function publicUsageSnapshot(value: unknown): UsageSnapshot {
  return usageSnapshotSchema.parse(value)
}
