/** Read-only organization accounting. Import only in the isolated usage worker.
 * Accounting snapshots are reported usage, not a real-time free-token guarantee
 * or a prepaid balance. Cached input is already included in inputTokens.
 */
import { z } from 'zod'
import { validAdminUsageKey } from './admin-credentials.js'

export interface UsageApiOptions {
  loadAdminKey: () => Promise<string>
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxPages?: number
}
export interface UsageQuery {
  /** Inclusive start and exclusive end, in Unix seconds. */
  startTime: number
  endTime: number
  /** Omit for all organization projects. */
  projectIds?: readonly string[]
  signal?: AbortSignal
}
export interface CompletionUsageRow {
  bucketStart: number
  bucketEnd: number
  model: string | null
  projectId: string | null
  serviceTier: string | null
  inputTokens: number
  outputTokens: number
  inputCachedTokens: number | null
  numModelRequests: number
}
export interface CostRow {
  bucketStart: number
  bucketEnd: number
  projectId: string | null
  lineItem: string | null
  amount: number
  currency: string
}
export interface AccountingSnapshot<Row> {
  startTime: number
  endTime: number
  /** Local receipt time in milliseconds; not an upstream completeness watermark. */
  fetchedAt: number
  rows: Row[]
}
export type CompletionUsageSnapshot = AccountingSnapshot<CompletionUsageRow>
export type CostsSnapshot = AccountingSnapshot<CostRow>

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const dimension = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/).nullable().optional()
const completionResult = z.object({
  object: z.literal('organization.usage.completions.result'),
  input_tokens: integer,
  output_tokens: integer,
  num_model_requests: integer,
  input_cached_tokens: integer.nullable().optional(),
  model: dimension,
  project_id: dimension,
  service_tier: dimension,
}).refine(value => value.input_cached_tokens == null || value.input_cached_tokens <= value.input_tokens)
const costResult = z.object({
  object: z.literal('organization.costs.result'),
  amount: z.object({ value: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[a-z]{3}$/) }),
  project_id: dimension,
  line_item: dimension,
})
function pageSchema<T extends z.ZodType>(result: T) {
  return z.object({
    object: z.literal('page'),
    data: z.array(z.object({ object: z.literal('bucket'), start_time: integer, end_time: integer,
      results: z.array(result).max(20_000) }).refine(bucket => bucket.end_time > bucket.start_time)).max(180),
    has_more: z.boolean(),
    next_page: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_+=/.-]+$/).nullable(),
  }).refine(page => page.has_more ? page.next_page !== null : page.next_page === null)
}
const completionsPage = pageSchema(completionResult)
const costsPage = pageSchema(costResult)
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ROWS = 100_000
const ENDPOINTS = {
  completions: 'https://api.openai.com/v1/organization/usage/completions',
  costs: 'https://api.openai.com/v1/organization/costs',
} as const

/** Deliberately avoids remote error bodies, request URLs and credential errors. */
export class UsageApiError extends Error {
  constructor(readonly code: 'invalid-query' | 'unavailable' | 'invalid-response' | 'pagination' | 'cancelled' | 'timeout') {
    super(`OpenAI accounting query ${code}.`)
    this.name = 'UsageApiError'
  }
}

function validateQuery(query: UsageQuery): void {
  if (!Number.isSafeInteger(query.startTime) || !Number.isSafeInteger(query.endTime)
    || query.startTime < 0 || query.endTime <= query.startTime || query.endTime - query.startTime > 366 * 86400
    || (query.projectIds !== undefined && (!Array.isArray(query.projectIds) || query.projectIds.length < 1
      || query.projectIds.length > 100 || new Set(query.projectIds).size !== query.projectIds.length
      || query.projectIds.some(id => typeof id !== 'string' || !/^proj_[A-Za-z0-9_-]{1,128}$/.test(id))))) {
    throw new UsageApiError('invalid-query')
  }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new UsageApiError('invalid-response')
  if (!response.body) throw new UsageApiError('invalid-response')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let bytes = 0
  let text = ''
  let finished = false
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    while (true) {
      if (signal.aborted) throw new UsageApiError('cancelled')
      const item = await reader.read()
      if (signal.aborted) throw new UsageApiError('cancelled')
      if (item.done) { finished = true; break }
      bytes += item.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new UsageApiError('invalid-response')
      text += decoder.decode(item.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    if (!finished) cancel()
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** No endpoint/header override, inference endpoint, retries or persistent key cache. */
export class OpenAIUsageApi {
  private readonly timeoutMs: number
  private readonly maxPages: number
  constructor(private readonly options: UsageApiOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.maxPages = options.maxPages ?? 32
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000
      || !Number.isInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 100) throw new UsageApiError('invalid-query')
  }

  async completions(query: UsageQuery): Promise<CompletionUsageSnapshot> {
    return this.query('completions', query) as Promise<CompletionUsageSnapshot>
  }
  async costs(query: UsageQuery): Promise<CostsSnapshot> {
    return this.query('costs', query) as Promise<CostsSnapshot>
  }

  private async query(kind: keyof typeof ENDPOINTS, query: UsageQuery): Promise<AccountingSnapshot<CompletionUsageRow | CostRow>> {
    validateQuery(query)
    if (query.signal?.aborted) throw new UsageApiError('cancelled')
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)
    const abort = () => controller.abort()
    query.signal?.addEventListener('abort', abort, { once: true })
    let abortListener: (() => void) | undefined
    const cancelled = new Promise<never>((_, reject) => {
      abortListener = () => reject(new UsageApiError(timedOut ? 'timeout' : 'cancelled'))
      controller.signal.addEventListener('abort', abortListener, { once: true })
    })
    const active = () => { if (controller.signal.aborted) throw new UsageApiError(timedOut ? 'timeout' : 'cancelled') }
    const work = async (): Promise<AccountingSnapshot<CompletionUsageRow | CostRow>> => {
      active()
      const apiKey = await this.options.loadAdminKey()
      active()
      if (!validAdminUsageKey(apiKey)) throw new UsageApiError('unavailable')
      const rows: Array<CompletionUsageRow | CostRow> = []
      const cursors = new Set<string>()
      const rowKeys = new Set<string>()
      let cursor: string | undefined
      for (let index = 0; index < this.maxPages; index++) {
        active()
        const url = new URL(ENDPOINTS[kind])
        url.searchParams.set('start_time', String(query.startTime))
        url.searchParams.set('end_time', String(query.endTime))
        url.searchParams.set('bucket_width', '1d')
        url.searchParams.set('limit', kind === 'completions' ? '31' : '180')
        for (const field of kind === 'completions' ? ['model', 'project_id', 'service_tier'] : ['project_id', 'line_item']) url.searchParams.append('group_by', field)
        for (const id of query.projectIds ?? []) url.searchParams.append('project_ids', id)
        if (cursor !== undefined) url.searchParams.set('page', cursor)
        const response = await (this.options.fetchImpl ?? fetch)(url.toString(), {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        })
        active()
        if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== 'https://api.openai.com')) throw new UsageApiError('unavailable')
        const raw = await readBounded(response, controller.signal)
        active()
        if (JSON.stringify(raw).includes(apiKey)) throw new UsageApiError('invalid-response')
        const page = kind === 'completions' ? completionsPage.parse(raw) : costsPage.parse(raw)
        for (const bucket of page.data) {
          // Daily buckets can extend beyond an unaligned query boundary.
          if (bucket.end_time <= query.startTime || bucket.start_time >= query.endTime) throw new UsageApiError('invalid-response')
          for (const result of bucket.results) {
            const common = { bucketStart: bucket.start_time, bucketEnd: bucket.end_time, projectId: result.project_id ?? null }
            if (query.projectIds !== undefined && (common.projectId === null || !query.projectIds.includes(common.projectId))) throw new UsageApiError('invalid-response')
            const row: CompletionUsageRow | CostRow = result.object === 'organization.usage.completions.result'
              ? { ...common, model: result.model ?? null, serviceTier: result.service_tier ?? null,
                inputTokens: result.input_tokens, outputTokens: result.output_tokens,
                inputCachedTokens: result.input_cached_tokens ?? null, numModelRequests: result.num_model_requests }
              : { ...common, lineItem: result.line_item ?? null, amount: result.amount.value, currency: result.amount.currency }
            const key = JSON.stringify([common.bucketStart, common.bucketEnd, common.projectId,
              'model' in row ? row.model : row.lineItem, 'serviceTier' in row ? row.serviceTier : row.currency])
            if (rowKeys.has(key)) throw new UsageApiError('pagination')
            rowKeys.add(key)
            rows.push(row)
            if (rows.length > MAX_ROWS) throw new UsageApiError('invalid-response')
          }
        }
        if (!page.has_more) return { startTime: query.startTime, endTime: query.endTime, fetchedAt: Date.now(), rows }
        const next = page.next_page!
        if (cursors.has(next)) throw new UsageApiError('pagination')
        cursors.add(next)
        cursor = next
      }
      throw new UsageApiError('pagination')
    }
    try { return await Promise.race([work(), cancelled]) }
    catch (error) { throw error instanceof UsageApiError ? error : new UsageApiError('invalid-response') }
    finally {
      clearTimeout(timer)
      query.signal?.removeEventListener('abort', abort)
      if (abortListener) controller.signal.removeEventListener('abort', abortListener)
      controller.abort()
    }
  }
}
