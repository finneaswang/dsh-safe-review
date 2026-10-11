import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIUsageApi, UsageApiError } from '../src/usage-api.js'

const key = 'sk-admin-testfixture000000000000'
const query = { startTime: 1_700_006_400, endTime: 1_700_010_000 }
const result = () => ({ object: 'organization.usage.completions.result', model: 'gpt-6-astra',
  project_id: 'proj_test', service_tier: 'default', input_tokens: 1000, output_tokens: 250,
  input_cached_tokens: 400, num_model_requests: 2 })
function page(results: unknown[] = [result()], next: string | null = null) {
  return { object: 'page', data: [{ object: 'bucket', start_time: query.startTime,
    end_time: query.startTime + 86400, results }], has_more: next !== null, next_page: next }
}
function response(value: unknown) { return new Response(JSON.stringify(value)) }
function fixture(fetchImpl = vi.fn(async () => response(page())), options = {}) {
  const loadAdminKey = vi.fn(async () => key)
  return { fetchImpl, loadAdminKey, api: new OpenAIUsageApi({ loadAdminKey, fetchImpl: fetchImpl as typeof fetch, ...options }) }
}
afterEach(() => vi.useRealTimers())

describe('read-only organization accounting', () => {
  it('queries all organization usage, sends admin only to fixed GET and includes cached input once', async () => {
    const f = fixture()
    const data = await f.api.completions(query)
    expect(data.rows).toEqual([{ bucketStart: query.startTime, bucketEnd: query.startTime + 86400,
      model: 'gpt-6-astra', projectId: 'proj_test', serviceTier: 'default', inputTokens: 1000,
      outputTokens: 250, inputCachedTokens: 400, numModelRequests: 2 }])
    const [address, init] = f.fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const url = new URL(address)
    expect(url.origin + url.pathname).toBe('https://api.openai.com/v1/organization/usage/completions')
    expect(url.searchParams.getAll('group_by')).toEqual(['model', 'project_id', 'service_tier'])
    expect(url.searchParams.has('project_ids')).toBe(false)
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${key}` } })
    expect(init.body).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain(key)
    expect(f.loadAdminKey).toHaveBeenCalledOnce()
  })

  it('follows opaque cursors and preserves the query/grouping/project filters', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(page([result()], 'page_a+/=')))
      .mockResolvedValueOnce(response(page([{ ...result(), model: 'gpt-5.6-terra', input_tokens: 5, input_cached_tokens: 0 }])))
    const f = fixture(fetchImpl)
    const data = await f.api.completions({ ...query, projectIds: ['proj_test'] })
    expect(data.rows).toHaveLength(2)
    const second = new URL(fetchImpl.mock.calls[1]![0])
    expect(second.searchParams.get('page')).toBe('page_a+/=')
    expect(second.searchParams.getAll('project_ids')).toEqual(['proj_test'])
    expect(second.searchParams.get('end_time')).toBe(String(query.endTime))
    expect(f.loadAdminKey).toHaveBeenCalledOnce()
  })

  it('uses Costs only for recorded currency amounts and retains credits, not a fabricated balance', async () => {
    const f = fixture(vi.fn(async () => response(page([{ object: 'organization.costs.result',
      amount: { value: -0.01, currency: 'usd' }, project_id: null, line_item: 'credit adjustment' }]))))
    const data = await f.api.costs(query)
    expect(data.rows[0]).toMatchObject({ amount: -0.01, currency: 'usd', projectId: null })
    const url = new URL((f.fetchImpl.mock.calls[0] as unknown as [string])[0])
    expect(url.pathname).toBe('/v1/organization/costs')
    expect(url.searchParams.getAll('group_by')).toEqual(['project_id', 'line_item'])
    expect(data).not.toHaveProperty('balance')
  })

  it('keeps absent dimensions and cached counts unknown and strips unrequested fields', async () => {
    const { model, project_id, service_tier, input_cached_tokens, ...partial } = result()
    const f = fixture(vi.fn(async () => response(page([{ ...partial, unexpected: 'sensitive payload' }]))))
    const row = (await f.api.completions(query)).rows[0]
    expect(row).toMatchObject({ model: null, projectId: null, serviceTier: null, inputCachedTokens: null })
    expect(JSON.stringify(row)).not.toContain('sensitive payload')
  })

  it.each([
    { input_tokens: -1 }, { input_tokens: '1000' }, { input_tokens: 1.2 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1 }, { output_tokens: null },
    { input_cached_tokens: 1001 }, { num_model_requests: null },
    { model: '' }, { model: ['gpt-6-astra'] }, { object: 'organization.usage.embeddings.result' },
  ])('rejects invalid accounting values: %j', async invalid => {
    const f = fixture(vi.fn(async () => response(page([{ ...result(), ...invalid }]))))
    await expect(f.api.completions(query)).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('does not return partial usage after an invalid next page', async () => {
    const f = fixture(vi.fn().mockResolvedValueOnce(response(page([result()], 'next')))
      .mockResolvedValueOnce(response({ object: 'page', data: [] })))
    await expect(f.api.completions(query)).rejects.toBeInstanceOf(UsageApiError)
  })

  it.each(['loop', 'duplicate', 'limit'])('bounds broken pagination: %s', async mode => {
    let index = 0
    const f = fixture(vi.fn(async () => {
      index++
      return response(page([{ ...result(), model: mode === 'duplicate' ? 'same' : `model-${index}` }], mode === 'loop' ? 'same-cursor' : `page-${index}`))
    }), { maxPages: 2 })
    await expect(f.api.completions(query)).rejects.toMatchObject({ code: 'pagination' })
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects inconsistent pagination flags and out-of-range buckets', async () => {
    for (const value of [{ ...page(), has_more: true }, { ...page(), next_page: 'unused' },
      { ...page(), data: [{ object: 'bucket', start_time: 1, end_time: 2, results: [result()] }] }]) {
      await expect(fixture(vi.fn(async () => response(value))).api.completions(query)).rejects.toBeInstanceOf(UsageApiError)
    }
  })

  it.each([401, 403, 429, 500, 302])('keeps HTTP %i bodies and keys out of error output', async status => {
    const f = fixture(vi.fn(async () => new Response(`private ${key}`, { status })))
    await expect(f.api.completions(query)).rejects.toThrow('OpenAI accounting query unavailable.')
  })

  it('rejects project keys before network access and does not expose loader errors', async () => {
    const f = fixture()
    const api = new OpenAIUsageApi({ loadAdminKey: async () => 'sk-proj-not-an-admin-key', fetchImpl: f.fetchImpl as typeof fetch })
    await expect(api.completions(query)).rejects.toMatchObject({ code: 'unavailable' })
    const throws = new OpenAIUsageApi({ loadAdminKey: async () => { throw new Error(`private ${key}`) } })
    await expect(throws.completions(query)).rejects.toThrow('OpenAI accounting query invalid-response.')
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('never returns a credential echoed by a malformed upstream response', async () => {
    const f = fixture(vi.fn(async () => response(page([{ ...result(), model: key }]))))
    await expect(f.api.completions(query)).rejects.toThrow('OpenAI accounting query invalid-response.')
  })

  it.each([{ startTime: -1 }, { endTime: query.startTime }, { projectIds: [] }, { projectIds: ['bad'] }])('validates query before credentials %j', async invalid => {
    const f = fixture()
    await expect(f.api.completions({ ...query, ...invalid })).rejects.toMatchObject({ code: 'invalid-query' })
    expect(f.loadAdminKey).not.toHaveBeenCalled()
  })

  it('rejects a mismatched project response and oversized response', async () => {
    await expect(fixture().api.completions({ ...query, projectIds: ['proj_other'] })).rejects.toMatchObject({ code: 'invalid-response' })
    const f = fixture(vi.fn(async () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } })))
    await expect(f.api.completions(query)).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('times out stalled credential loaders and providers even if they ignore cancellation', async () => {
    vi.useFakeTimers()
    for (const loadStalled of [true, false]) {
      const api = new OpenAIUsageApi({ timeoutMs: 20, loadAdminKey: loadStalled ? () => new Promise(() => {}) : async () => key,
        fetchImpl: (() => new Promise(() => {})) as typeof fetch })
      const answer = expect(api.completions(query)).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(20)
      await answer
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors caller cancellation before and during network work', async () => {
    const controller = new AbortController()
    const f = fixture(vi.fn(() => new Promise<Response>(() => {})))
    const answer = expect(f.api.completions({ ...query, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
    controller.abort()
    await answer
    await expect(f.api.completions({ ...query, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
  })
})
