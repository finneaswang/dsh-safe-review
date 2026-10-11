import { resolve } from 'node:path'
import { TierBudget, type TierId, type TierReservation, type TierConfig, type TierQuotaSnapshot } from './tier-budget.js'
import { createUsageCache } from './usage-cache.js'
import type { ReviewRouting } from './openai-reviewer.js'
import type { UsageSnapshot, UsageTierId } from './usage-contract.js'
import type { UsageAccounting } from './usage-accounting.js'

// Standard, short-context prices verified 2026-10-11. Input uses the documented
// cache-write upper rate (1.25x); discounts/free incentives are never assumed bills.
export const REVIEW_TIERS: Record<TierId, TierConfig> = {
  high: { model: 'gpt-6-astra', inputMicrousdPerMillion: 12_500_000, outputMicrousdPerMillion: 50_000_000 },
  middle: { model: 'gpt-5.6-terra', inputMicrousdPerMillion: 2_500_000, outputMicrousdPerMillion: 12_000_000 },
  paid: { model: 'gpt-6-luna', inputMicrousdPerMillion: 125_000, outputMicrousdPerMillion: 500_000 },
}
const uiTier = (tier: TierId): UsageTierId => tier === 'high' ? 'free-primary' : tier === 'middle' ? 'free-secondary' : 'paid'
interface Options { dataDir: string; primaryTokens: number; secondaryTokens: number; paidDailyUsd: number }

export function createTieredReview(options: Options) {
  const accounting = createUsageCache(resolve(options.dataDir, 'admin-usage.key'))
  const budget = new TierBudget({ directory: resolve(options.dataDir, 'budget'), tiers: REVIEW_TIERS,
    paidDailyBudgetMicrousd: Math.round(options.paidDailyUsd * 1_000_000) })
  const quotaOf = (a: UsageAccounting): TierQuotaSnapshot => ({ day: a.day, fetchedAt: a.fetchedAt, pools: {
    high: { used: a.primaryUsed, limit: options.primaryTokens },
    middle: { used: a.secondaryUsed, limit: options.secondaryTokens },
  } })
  const routing: ReviewRouting = {
    async reserve(input, signal) {
      if (signal.aborted) return undefined
      const a = await accounting.get()
      if (signal.aborted) return undefined
      const quota = a ? quotaOf(a) : undefined
      const result = await budget.reserve({ ...input, ...(quota ? { quota } : {}) })
      return result.kind === 'reserved' ? { model: result.reservation.model, reservation: result.reservation } : undefined
    },
    settle: (receipt, usage) => budget.settle(receipt as TierReservation, usage),
  }
  async function snapshot(): Promise<UsageSnapshot> {
    const a = accounting.peek()
    const now = Date.now()
    const current = a && a.day === new Date(now).toISOString().slice(0, 10) && a.fetchedAt <= now && now - a.fetchedAt <= 300_000
    const b = await budget.snapshot(current ? quotaOf(a) : undefined)
    const fresh = current && a.day === b.day && b.quotaStatus === 'fresh'
    const last = b.events.filter(event => event.kind !== 'legacy-import').at(-1)
    return {
      schemaVersion: 1, status: fresh ? 'ready' : 'unavailable', updatedAt: Date.now(),
      resetsAt: Date.parse(`${b.day}T00:00:00Z`) + 86_400_000,
      activeTier: uiTier(b.tier),
      tiers: (['high', 'middle', 'paid'] as const).map(tier => {
        const pool = tier === 'paid' ? undefined : b.freePools?.[tier]
        const limit = pool?.limit ?? (tier === 'high' ? options.primaryTokens : options.secondaryTokens)
        const observed = fresh ? tier === 'high' ? a.primaryUsed : a.secondaryUsed : null
        const used = fresh && pool ? pool.estimatedUsed : null
        return { id: uiTier(tier), model: REVIEW_TIERS[tier].model, localUsedTokens: b.tiers[tier].tokens,
          allowance: tier === 'paid' ? null : { limitTokens: limit, usedTokens: used,
            remainingTokens: fresh && pool ? pool.estimatedRemaining : null,
            source: fresh ? 'local-estimate' as const : 'unknown' as const, updatedAt: fresh ? b.quotaFetchedAt : null,
            officialUsedTokens: observed, officialUsageUpdatedAt: fresh ? a.fetchedAt : null },
          estimatedCostUsd: tier === 'middle' && b.legacyIncomplete ? null : b.tiers[tier].estimatedRetailCostMicrousd / 1_000_000 }
      }),
      paidBudget: { limitUsd: b.paidDailyBudgetMicrousd / 1_000_000,
        estimatedUsedUsd: b.tiers.paid.estimatedRetailCostMicrousd / 1_000_000,
        remainingUsd: b.paidRemainingMicrousd / 1_000_000 },
      accountCosts: a?.costsFetchedAt && a.day === b.day ? { todayUsd: a.todayUsd, monthUsd: a.monthUsd,
        updatedAt: a.costsFetchedAt, source: 'official-costs' } : null,
      accountCredit: { balanceUsd: null, source: 'unknown', updatedAt: null },
      lastSwitch: last ? { sequence: last.sequence, at: last.createdAt,
        from: uiTier(last.from), to: uiTier(last.to), reason: last.kind === 'utc-reset' ? 'daily-reset'
          : last.kind === 'paid-budget-exhausted' ? 'paid-budget-exhausted' : 'free-exhausted' } : null,
    }
  }
  return { routing, snapshot, stop: accounting.stop }
}
