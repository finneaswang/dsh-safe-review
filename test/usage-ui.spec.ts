import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Cordis from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { mountUsageRemote } from '../src/usage-remote.js'
import { publicUsageSnapshot, type UsageSnapshot, type UsageSwitch } from '../src/usage-contract.js'
import { initialUsageClientState, UsageController, type UsageClientState } from '../src/client/usage-state.js'
import { moneyText, tokenText, switchText } from '../src/client/presentation.js'
import { zh, type UsageLocaleKey } from '../src/client/locales.js'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UsageCard, UsagePanel } from '../src/client/usage-view.js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { bundlePatchPaths, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.useRealTimers() })
const now = 1_791_676_800_000
function snapshot(change: UsageSwitch | null = null): UsageSnapshot {
  return {
    schemaVersion: 1, status: 'ready', updatedAt: now, resetsAt: now + 86_400_000,
    activeTier: change?.to ?? 'free-primary',
    tiers: [
      { id: 'free-primary', model: 'gpt-6', localUsedTokens: 150,
        allowance: { limitTokens: 250_000, usedTokens: 150, remainingTokens: 249_850, source: 'local-estimate', updatedAt: now }, estimatedCostUsd: 0 },
      { id: 'free-secondary', model: 'gpt-5.6-terra', localUsedTokens: 0,
        allowance: { limitTokens: 2_500_000, usedTokens: null, remainingTokens: null, source: 'unknown', updatedAt: null }, estimatedCostUsd: null },
      { id: 'paid', model: 'gpt-5.6-luna', localUsedTokens: 0, allowance: null, estimatedCostUsd: 0 },
    ], paidBudget: { limitUsd: 1, estimatedUsedUsd: 0.005, remainingUsd: 0.995 },
    accountCosts: null, accountCredit: { balanceUsd: null, source: 'unknown', updatedAt: null }, lastSwitch: change,
  }
}
const t = (key: UsageLocaleKey, params: Record<string, string> = {}): string =>
  Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), zh[key])
function harness(read: () => Promise<unknown>) {
  let state: UsageClientState = { ...initialUsageClientState }
  const store = { getSnapshot: () => state, set: (value: UsageClientState) => { state = value } }
  const controller = new UsageController(store, read, () => now)
  cleanup.push(() => controller.dispose())
  return { controller, state: () => state }
}

describe('public usage boundary', () => {
  it('strips undeclared secrets and context recursively and detaches the result', () => {
    const source = { ...snapshot(), key: 'FIXTURE-SECRET', messages: ['PRIVATE-FIXTURE'],
      tiers: snapshot().tiers.map(tier => ({ ...tier, key: 'NESTED-FIXTURE' })) }
    const safe = publicUsageSnapshot(source)
    expect(JSON.stringify(safe)).not.toMatch(/FIXTURE|messages|key/)
    safe.tiers[0]!.localUsedTokens = 200
    expect(source.tiers[0]!.localUsedTokens).toBe(150)
  })
  it('rejects fake zero balance when its source is unknown', () => {
    expect(() => publicUsageSnapshot({ ...snapshot(), accountCredit: { balanceUsd: 0, source: 'unknown', updatedAt: null } })).toThrow()
    const input = snapshot()
    input.tiers[1]!.allowance!.remainingTokens = 0
    expect(() => publicUsageSnapshot(input)).toThrow()
  })
  it('rejects malformed, duplicate and incomplete ready tiers', () => {
    expect(() => publicUsageSnapshot({ ...snapshot(), tiers: [] })).toThrow()
    expect(() => publicUsageSnapshot({ ...snapshot(), tiers: Array(3).fill(snapshot().tiers[0]) })).toThrow()
    expect(() => publicUsageSnapshot({ ...snapshot(), updatedAt: NaN })).toThrow()
  })
  it('keeps unknown amounts distinct from known zero and tiny paid cost', () => {
    expect(tokenText(null, t)).toBe('未知')
    expect(tokenText(0, t)).toBe('0')
    expect(moneyText(null, t)).toBe('未知')
    expect(moneyText(0.00000025, t)).toContain('0.00000025')
  })
  it('allows official billing credits while keeping plugin budgets nonnegative', () => {
    const input = { ...snapshot(), accountCosts: { todayUsd: -0.25, monthUsd: 1.75, updatedAt: now, source: 'official-costs' } }
    expect(publicUsageSnapshot(input).accountCosts?.todayUsd).toBe(-0.25)
    expect(() => publicUsageSnapshot({ ...input, paidBudget: { limitUsd: 1, estimatedUsedUsd: -1, remainingUsd: 2 } })).toThrow()
  })
})

describe('official read-only usage Remote', () => {
  async function setup(read: () => unknown | Promise<unknown>) {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    const fiber = ctx.plugin({ apply(owner: Context) { mountUsageRemote(owner, read) } })
    await fiber
    await new Promise(resolve => setTimeout(resolve, 0))
    return { ctx, fiber }
  }
  it('serves only a validated detached snapshot through the real Gateway', async () => {
    const input = { ...snapshot(), token: 'FAKE-KEY-MUST-NOT-LEAVE' }
    const { ctx } = await setup(() => input)
    const result = await ctx.typertGateway.invoke({ namespace: 'safeReviewUsage', method: 'snapshot', args: {} })
    expect(result).toEqual(snapshot())
    expect(JSON.stringify(result)).not.toContain('FAKE-KEY')
    await expect(ctx.typertGateway.invoke({ namespace: 'safeReviewUsage', method: 'approve', args: {} })).rejects.toThrow()
  })
  it('does not expose provider exceptions and degrades to unavailable', async () => {
    const { ctx } = await setup(() => { throw new Error('FIXTURE-PRIVATE-PROMPT-AND-KEY') })
    const result = await ctx.typertGateway.invoke({ namespace: 'safeReviewUsage', method: 'snapshot', args: {} })
    expect(result).toMatchObject({ status: 'unavailable', tiers: [] })
    expect(JSON.stringify(result)).not.toContain('FIXTURE')
  })
  it('withdraws its method when the owning plugin is unloaded', async () => {
    const { ctx, fiber } = await setup(() => snapshot())
    await fiber.dispose()
    await expect(ctx.typertGateway.invoke({ namespace: 'safeReviewUsage', method: 'snapshot', args: {} })).rejects.toThrow()
  })
  it('does not require a Gateway or registry in CLI-only approval compositions', async () => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    expect(() => mountUsageRemote(ctx, () => snapshot())).not.toThrow()
    expect(ctx.get('safeReviewUsage')).toBeUndefined()
  })
})

describe('usage refresh and switch notices', () => {
  const switched: UsageSwitch = { sequence: 2, at: now + 5000, from: 'free-primary', to: 'free-secondary', reason: 'free-exhausted' }
  it('does not replay a persisted switch after Desktop restart', async () => {
    const h = harness(async () => snapshot(switched))
    await h.controller.refresh()
    expect(h.state().notice).toBeNull()
    expect(h.state().snapshot?.activeTier).toBe('free-secondary')
  })
  it('shows a new switch once and does not re-show it on unchanged polls', async () => {
    let next = snapshot()
    const h = harness(async () => next)
    await h.controller.refresh()
    next = snapshot(switched)
    await h.controller.refresh()
    expect(h.state().notice).toEqual(switched)
    expect(switchText(switched, 'gpt-5.6-terra', t)).toContain('免费余量不足以覆盖本次审核')
    h.controller.dismissNotice()
    await h.controller.refresh()
    expect(h.state().notice).toBeNull()
  })
  it('retains the last result with an explicit stale flag after failure', async () => {
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new Error('SECRET'))
    const h = harness(read)
    await h.controller.refresh()
    await h.controller.refresh()
    expect(h.state()).toMatchObject({ stale: true, refreshing: false, snapshot: snapshot(), refreshedAt: now })
    expect(JSON.stringify(h.state())).not.toContain('SECRET')
  })
  it('does not substitute unknown for a last known balance on an unavailable reply', async () => {
    const h = harness(vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({ ...snapshot(), status: 'unavailable', tiers: [] }))
    await h.controller.refresh()
    await h.controller.refresh()
    expect(h.state().stale).toBe(true)
    expect(h.state().snapshot?.tiers).toHaveLength(3)
  })
  it('publishes an unavailable but complete snapshot with known local records and unknown quota', async () => {
    const data = snapshot()
    data.status = 'unavailable'
    for (const tier of data.tiers) if (tier.allowance) {
      tier.allowance = { ...tier.allowance, usedTokens: null, remainingTokens: null, source: 'unknown' }
    }
    const h = harness(async () => data)
    await h.controller.refresh()
    expect(h.state()).toMatchObject({ stale: true, snapshot: data })
    expect(h.state().snapshot?.tiers[0]?.localUsedTokens).toBe(150)
  })
  it('announces paid-budget failure as human confirmation instead of a model switch', async () => {
    const failure: UsageSwitch = { ...switched, from: 'paid', to: 'paid', reason: 'paid-budget-exhausted' }
    let data = snapshot()
    const h = harness(async () => data)
    await h.controller.refresh()
    data = snapshot(failure)
    data.paidBudget = { limitUsd: 1, estimatedUsedUsd: 0.9997, remainingUsd: 0.0003 }
    await h.controller.refresh()
    expect(h.state().notice).toEqual(failure)
    expect(switchText(failure, 'gpt-6-luna', t)).toContain('已转为人工确认')
    expect(switchText(failure, 'gpt-6-luna', t)).not.toContain('切换')
  })
  it('coalesces overlapping refreshes and ignores a completion after disposal', async () => {
    let finish!: (value: unknown) => void
    const read = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const h = harness(read)
    const first = h.controller.refresh()
    expect(h.controller.refresh()).toBe(first)
    expect(read).toHaveBeenCalledTimes(1)
    h.controller.dispose()
    finish(snapshot())
    await first
    expect(h.state().snapshot).toBeNull()
  })
  it('polls on the configured interval and clears the timer when unloaded', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => snapshot())
    const h = harness(read)
    h.controller.start()
    h.controller.start()
    await vi.advanceTimersByTimeAsync(10_001)
    expect(read).toHaveBeenCalledTimes(3)
    h.controller.dispose()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(read).toHaveBeenCalledTimes(3)
  })
})

describe('usage card rendering and packaged client', () => {
  it('preserves the Host approval bundle alongside the browser companion in the published manifest', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.dsh.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(manifest.dsh.client).toMatchObject({ platform: 'web' })
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-plugin-manager')
    expect(manifest.exports['./client'].default).toBe('./lib/client.js')
    expect(manifest.files).toEqual(expect.arrayContaining(['lib', 'cordis.patch.yml']))
    // Exercise the pinned official profile loader's resolution, YAML parsing,
    // validation and composition without loading a profile or executing a plugin.
    const paths = bundlePatchPaths(root, manifest.dsh.bundle)
    const entries = composeEntries(paths.map(path => loadOverlayPatches('dsh', path)))
    expect(entries).toEqual([{ id: 'finneas-safe-review', name: '@finneas/dsh-safe-review', config: {} }])
  })
  it('renders three tiers and clearly separates plugin budget, costs and unknown account credit', () => {
    const html = renderToStaticMarkup(createElement(UsageCard, {
      state: { ...initialUsageClientState, snapshot: snapshot(), refreshedAt: now }, refresh() {}, t,
    }))
    expect(html.match(/data-tier=/g)).toHaveLength(3)
    for (const text of ['第一档', '第二档', '第三档', '249,850', '插件本地估算', '额度余量尚未确认',
      '第三档今日预算剩余', '账户余额', '未知', '最新刷新', '免费额度重置', '按实际 token 计费']) expect(html).toContain(text)
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('platform.openai.com/settings/organization/billing/overview')
  })
  it('renders signed official costs and an explicit stale status', () => {
    const data = snapshot()
    data.accountCosts = { todayUsd: -0.2, monthUsd: 1.2, source: 'official-costs', updatedAt: now }
    const html = renderToStaticMarkup(createElement(UsageCard, {
      state: { ...initialUsageClientState, snapshot: data, refreshedAt: now, stale: true }, refresh() {}, t,
    }))
    expect(html).toContain('数据待同步')
    expect(html).toContain('官方 Costs 数据')
    expect(html).toContain('0.20')
    expect(html).toContain('role="status"')
  })
  it('separates official token observations from conservative accounting and remaining estimates', () => {
    const data = snapshot()
    data.tiers[0]!.allowance = { ...data.tiers[0]!.allowance!, officialUsedTokens: 123, officialUsageUpdatedAt: now }
    const html = renderToStaticMarkup(createElement(UsageCard, {
      state: { ...initialUsageClientState, snapshot: data, refreshedAt: now }, refresh() {}, t,
    }))
    for (const text of ['官方统计已用 token', '>123<', '保守计量已用 token', '>150<', '预计免费剩余 token',
      '249,850', '插件已用与预留 token', '按标价估算成本']) expect(html).toContain(text)
  })
  it('shows a paid budget alert without pretending the selected model is running or all funds are zero', () => {
    const data = snapshot({ sequence: 5, at: now, from: 'paid', to: 'paid', reason: 'paid-budget-exhausted' })
    data.paidBudget = { limitUsd: 1, estimatedUsedUsd: 0.9997, remainingUsd: 0.0003 }
    const html = renderToStaticMarkup(createElement(UsageCard, {
      state: { ...initialUsageClientState, snapshot: data, refreshedAt: now }, refresh() {}, t,
    }))
    expect(html).toContain('已转为人工确认')
    expect(html).toContain('0.0003')
    expect(html).toContain('当前档位')
    expect(html).not.toContain('正在使用')
  })
  it('only contributes content to the Safe Review bundle detail', () => {
    const element = createElement(UsagePanel, {
      subject: { kind: 'bundle', pkg: { name: '@other/plugin', installed: true, enabled: true, rows: [] } },
      useUsage: selector => selector(initialUsageClientState), refresh() {}, dismissNotice() {}, openUsage() {}, t,
    })
    expect(renderToStaticMarkup(element)).toBe('')
  })
  it('builds the official lazy-CJS contract and mounts only read-only RPC and additive UI seats', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    execFileSync(process.execPath, ['scripts/build-client.mjs'], { cwd: root, stdio: 'pipe' })
    let registration: { id: string; factory: (load: (name: string) => unknown) => { apply: (ctx: unknown) => Promise<void>; inject: string[] } } | undefined
    const browser = { __ModuleLoader__: { load(value: typeof registration) { registration = value } } }
    runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: browser, setTimeout, clearTimeout })
    expect(registration?.id).toBe('@finneas/dsh-safe-review')
    const imports: string[] = []
    const plugin = registration!.factory(name => {
      imports.push(name)
      if (name === 'react') return { createElement }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Toast: () => null }
      if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore(initial: UsageClientState) {
        let value = initial
        return { getSnapshot: () => value, set(next: UsageClientState) { value = next } }
      } }
      throw new Error(`Unexpected client runtime import: ${name}`)
    })
    expect(imports).toEqual(expect.arrayContaining(['react', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives']))
    // Run the published Client Gateway and companion in real Cordis plugin
    // scopes. A plain-object Context cannot detect missing namespace injection.
    let gateway: typeof plugin | undefined
    runInNewContext(readFileSync(new URL('../node_modules/@deepseek-ai/dsh-api-gateway/lib/client.js', import.meta.url), 'utf8'), {
      window: { __ModuleLoader__: { load(value: { factory: (load: (name: string) => unknown) => typeof plugin }) {
        gateway = value.factory(name => {
          if (name === '@deepseek-ai/cordis') return Cordis
          throw new Error(`Unexpected Gateway runtime import: ${name}`)
        })
      } } },
      AbortController, AbortSignal, setTimeout, clearTimeout, crypto: globalThis.crypto,
    })
    const host = new Context()
    const client = new Context()
    cleanup.push(() => host.fiber.dispose(), () => client.fiber.dispose())
    await host.plugin(TypertRegistry)
    await host.plugin(TypertGateway)
    const read = vi.fn(() => snapshot())
    await host.plugin({ apply(owner: Context) { mountUsageRemote(owner, read) } })
    await vi.waitFor(() => expect(host.get('safeReviewUsage')).toBeDefined())
    await client.plugin(TypertRegistry)
    const call = vi.fn(async (_path: string, endpoint: string, payload: { args: Record<string, unknown> }) => {
      const [namespace, method] = endpoint.split('/')
      return { ok: true, value: await host.typertGateway.invoke({ namespace: namespace!, method: method!, args: payload.args }) }
    })
    client.provide('connection', {
      rpc: { call, async *open() {} },
      registerGenerationSource: () => () => {}, start: () => ({ stop() {} }),
    } as never)
    await client.plugin(gateway!)
    const seats: Array<{ name: string; id: string; inject: () => { hooks: { usage: { getSnapshot(): UsageClientState } } } }> = []
    const seatDisposers: Array<() => unknown> = []
    cleanup.push(async () => { for (const dispose of seatDisposers.reverse()) await dispose() })
    client.provide('locale', { register: () => () => {} } as never)
    client.provide('pluginNavigation', { openBundle: vi.fn() })
    client.provide('slots', {
      inject(_seat: string, action: () => () => void) { seatDisposers.push(action()) },
      register(options: typeof seats[number]) { seats.push(options); return () => {} },
    } as never)
    const companion = client.plugin(plugin)
    await companion
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    await client.plugin({ inject: ['remote'], apply(scope: Context) {
      expect(() => scope.remote.safeReviewUsage.snapshot()).toThrow('cannot get property "remote.safeReviewUsage" without inject')
    } })
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['/api', 'safeReviewUsage/snapshot', { args: {} }])
    expect(client.typert.remotes.list().map(descriptor => descriptor.method)).toEqual(['snapshot'])
    expect(seats.map(seat => [seat.name, seat.id])).toEqual([
      ['shell.overlay', 'finneas-safe-review.switch-toast'], ['plugins.detail.section', 'finneas-safe-review.usage'],
    ])
    await vi.waitFor(() => expect(seats[0]?.inject().hooks.usage.getSnapshot().snapshot?.tiers).toHaveLength(3))
    await companion.dispose()
    expect(client.get('remote.safeReviewUsage')).toBeUndefined()
    client.emit('connection/reset')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(read).toHaveBeenCalledOnce()
  })
})
