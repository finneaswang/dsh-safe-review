import { z } from 'zod'
import type { CompletionUsageSnapshot, CostsSnapshot } from './usage-api.js'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const instant = count.max(8_640_000_000_000_000)
function utcDay(time: number): string | undefined {
  return Number.isSafeInteger(time) && time >= 0 && time <= 8_640_000_000_000_000
    ? new Date(time).toISOString().slice(0, 10) : undefined
}
function validDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && utcDay(Date.parse(`${day}T00:00:00Z`)) === day
}
export const accountingSchema = z.object({
  version: z.literal(1), day: z.string().refine(validDay), fetchedAt: instant,
  primaryUsed: count, secondaryUsed: count, unmappedTokens: count,
  todayUsd: z.number().finite().nullable(), monthUsd: z.number().finite().nullable(), costsFetchedAt: instant.nullable(),
}).strict().superRefine((value, ctx) => {
  if (utcDay(value.fetchedAt) !== value.day) ctx.addIssue({ code: 'custom', message: 'Usage receipt must belong to its UTC day.' })
  if (value.costsFetchedAt !== null && utcDay(value.costsFetchedAt) !== value.day) {
    ctx.addIssue({ code: 'custom', message: 'Costs receipt must belong to its UTC day.' })
  }
  if (value.costsFetchedAt === null && (value.todayUsd !== null || value.monthUsd !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Unverified costs cannot advertise an amount.' })
  }
})
export type UsageAccounting = z.infer<typeof accountingSchema>

// A pinned mapping for this account's selected models. Unrecognized usage is
// charged to both estimates, never silently treated as unused/free capacity.
const primary = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna']
const secondary = ['gpt-5.6-terra', 'gpt-5.6-luna']
function matches(model: string | null, names: string[]): boolean {
  return model !== null && names.some(name => model === name || new RegExp(`^${name.replaceAll('.', '\\.')}\\-\\d{4}-\\d{2}-\\d{2}$`).test(model))
}
export function summarizeAccounting(usage: CompletionUsageSnapshot, costs?: CostsSnapshot): UsageAccounting {
  const day = utcDay(usage.startTime * 1000)
  if (day === undefined || !validDay(day)) throw new Error('Invalid accounting day.')
  const midnight = Date.parse(`${day}T00:00:00Z`) / 1000
  if (usage.startTime !== midnight || !Number.isSafeInteger(usage.endTime)
    || usage.endTime <= midnight || usage.endTime > midnight + 86400) throw new Error('Accounting requires one UTC day.')
  let primaryUsed = 0, secondaryUsed = 0, unmappedTokens = 0
  for (const row of usage.rows) {
    if (![row.inputTokens, row.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)
      || !Number.isSafeInteger(row.bucketStart) || !Number.isSafeInteger(row.bucketEnd)
      || row.bucketStart < midnight || row.bucketStart >= usage.endTime || row.bucketEnd <= row.bucketStart
      || row.bucketEnd > midnight + 86400) throw new Error('Invalid daily usage row.')
    const tokens = row.inputTokens + row.outputTokens
    if (matches(row.model, primary)) primaryUsed += tokens
    else if (matches(row.model, secondary)) secondaryUsed += tokens
    else { primaryUsed += tokens; secondaryUsed += tokens; unmappedTokens += tokens }
  }
  // All projects and service tiers are deliberately included. This is a
  // conservative account-usage estimate, not proof of complimentary eligibility.
  let todayUsd: number | null = null, monthUsd: number | null = null, costsFetchedAt: number | null = null
  const monthStart = Date.parse(`${day.slice(0, 7)}-01T00:00:00Z`) / 1000
  // A partial or foreign-month query must not be labelled as this month's bill.
  // Cost failures do not discard otherwise valid usage needed by the reviewer.
  if (costs && costs.startTime === monthStart && costs.endTime === usage.endTime
    && utcDay(costs.fetchedAt) === day && costs.rows.every(row => row.currency === 'usd'
      && Number.isFinite(row.amount) && Math.abs(row.amount) <= Number.MAX_SAFE_INTEGER
      && Number.isSafeInteger(row.bucketStart) && Number.isSafeInteger(row.bucketEnd)
      && row.bucketStart >= monthStart && row.bucketStart < costs.endTime
      && row.bucketEnd > row.bucketStart && row.bucketEnd <= midnight + 86400)) {
    monthUsd = costs.rows.reduce((sum, row) => sum + row.amount, 0)
    todayUsd = costs.rows.filter(row => row.bucketStart >= midnight).reduce((sum, row) => sum + row.amount, 0)
    if (Number.isFinite(monthUsd) && Number.isFinite(todayUsd)) costsFetchedAt = costs.fetchedAt
    else { monthUsd = null; todayUsd = null }
  }
  return accountingSchema.parse({ version: 1, day, fetchedAt: usage.fetchedAt,
    primaryUsed, secondaryUsed, unmappedTokens, todayUsd, monthUsd, costsFetchedAt })
}
