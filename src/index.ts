/** DSH 0.2.0-rc.2 gate: native approvals plus a monotonic, one-use execution guard. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { apply as officialRemoteApply } from '@deepseek-ai/dsh-api-remotes'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-commands'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { assess, type Assessment } from './policy.js'
import { review } from './reviewer.js'
import { DailyBudget, type BudgetReservation } from './budget.js'
import { createOpenAIReviewer } from './openai-reviewer.js'
import { mountUserContext } from './user-context.js'
import { loadInferenceKey } from './credentials.js'
import { modelEligibility } from './model-eligibility.js'
import { createTieredReview } from './tiered-review.js'
import { mountUsageRemote } from './usage-remote.js'

export const name = 'finneas-safe-review'
export const inject = ['tools', 'approval', 'sandboxPolicy']
export interface Config {
  advisoryModel?: boolean
  reviewerTimeoutMs?: number
  approvalTimeoutMs?: number
  protectedRoots?: string[]
  reviewerMode?: 'advisory' | 'openai' | 'tiered'
  primaryTokenLimit?: number
  secondaryTokenLimit?: number
  paidDailyUsd?: number
  openaiModel?: string
  reviewerDataDir?: string
  openaiKeyFile?: string
  dailyTokenLimit?: number
  maxOutputTokens?: number
}
export const Config: z<Config> = z.object({
  advisoryModel: z.boolean().default(true),
  reviewerTimeoutMs: z.number().default(15_000),
  approvalTimeoutMs: z.number().default(300_000),
  protectedRoots: z.array(z.string()).default([]),
  reviewerMode: z.union([z.const('advisory'), z.const('openai'), z.const('tiered')]).default('advisory'),
  primaryTokenLimit: z.number().default(250_000),
  secondaryTokenLimit: z.number().default(2_500_000),
  paidDailyUsd: z.number().default(1),
  openaiModel: z.string().default('gpt-5.6-terra'),
  reviewerDataDir: z.string(),
  openaiKeyFile: z.string(),
  dailyTokenLimit: z.number().default(200_000),
  maxOutputTokens: z.number().default(2048),
})
declare module '@deepseek-ai/cordis' {
  interface Context { safeReviewStatus: { readonly version: string; readonly automatic: string } }
}
const require = createRequire(import.meta.url)
const OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PEERS = ['dsh-tools', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-user-approval', 'dsh-sandbox-policy', 'dsh-api-remotes']

/** Pin the implementation whose monotonic guard and remote approval semantics were tested. */
export function assertCompatibility(): void {
  for (const peer of PEERS) {
    if (require(`@deepseek-ai/${peer}/package.json`).version !== '0.2.0-rc.2') {
      throw new Error(`Safe Review requires the coherent DSH 0.2.0-rc.2 cohort (${peer} differs).`)
    }
  }
  if (require('@deepseek-ai/cordis/package.json').version !== '4.0.4') throw new Error('Safe Review requires Cordis 4.0.4.')
}
function digest(exec: Readonly<ToolExecution>): string {
  return createHash('sha256').update(JSON.stringify([exec.name, exec.callId, exec.arguments])).digest('hex')
}
/** Enforce DSH's readonly identity contract across its later around-dispatch middleware. */
function sealApprovedExecution(exec: Readonly<ToolExecution>, fingerprint: string): void {
  // A pre-execute listener could replace the originally frozen argument object
  // with an equivalent mutable value. Capture and freeze the exact approved JSON
  // again so neither property replacement nor nested mutation changes the body.
  const args: unknown = JSON.parse(JSON.stringify(exec.arguments))
  if (digest({ ...exec, arguments: args }) !== fingerprint) throw new Error('Approved execution arguments changed while being sealed.')
  const pending: unknown[] = [args]
  while (pending.length) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object') continue
    for (const child of Object.values(value)) pending.push(child)
    Object.freeze(value)
  }
  const descriptors: PropertyDescriptorMap = {
    arguments: { value: args, writable: false, configurable: false, enumerable: true },
  }
  for (const key of ['token', 'name', 'callId', 'rootCallId', 'agent', 'parent', 'schema'] as const) {
    descriptors[key] = { value: exec[key], writable: false, configurable: false, enumerable: Object.hasOwn(exec, key) }
  }
  Object.defineProperties(exec, descriptors)
  // signal stays writable: the pinned official runtime fuses/replaces it while
  // dispatching. This protects the supported pipeline, not arbitrary Node code.
}
/** Reject additional automatic answerers; only the pinned official UI bridge may answer. */
export function humanChannelProblem(ctx: Context): string | undefined {
  const hooks = ctx.events._hooks['approval/request'] ?? []
  if (hooks.length === 0) return 'No native human approval channel is connected.'
  for (const hook of hooks) {
    if (hook.ctx.fiber.runtime?.callback !== officialRemoteApply) {
      return 'Another approval answerer is installed. Disable competing auto-approval plugins before proceeding.'
    }
  }
  return undefined
}

/** Mount the gate without changing presets, global settings or durable permission state. */
export function apply(ctx: Context, config: Config = {}): void {
  assertCompatibility()
  const approvalTimeoutMs = config.approvalTimeoutMs ?? 300_000
  const reviewerTimeoutMs = config.reviewerTimeoutMs ?? 15_000
  if (!Number.isInteger(approvalTimeoutMs) || approvalTimeoutMs < 100 || approvalTimeoutMs > 600_000) throw new Error('approvalTimeoutMs must be between 100 and 600000.')
  if (!Number.isInteger(reviewerTimeoutMs) || reviewerTimeoutMs < 100 || reviewerTimeoutMs > 60_000) throw new Error('reviewerTimeoutMs must be between 100 and 60000.')
  const options = { protectedRoots: [OWN_ROOT, ...(config.protectedRoots ?? []).map(path => resolve(path))] }
  const mode = config.reviewerMode ?? 'advisory'
  if (!['advisory', 'openai', 'tiered'].includes(mode)) throw new Error('Unknown reviewerMode.')
  const model = config.openaiModel ?? 'gpt-5.6-terra'
  if (!/^gpt-[a-zA-Z0-9.-]{1,80}$/.test(model)) throw new Error('Invalid independent reviewer model.')
  const dailyTokenLimit = config.dailyTokenLimit ?? 200_000
  const maxOutputTokens = config.maxOutputTokens ?? 2048
  if (!Number.isInteger(dailyTokenLimit) || dailyTokenLimit < 10_000 || dailyTokenLimit > 2_000_000) throw new Error('dailyTokenLimit must be between 10000 and 2000000.')
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 4096) throw new Error('maxOutputTokens must be between 256 and 4096.')
  const dataDir = resolve(config.reviewerDataDir ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'safe-review'))
  const keyFile = resolve(config.openaiKeyFile ?? resolve(dataDir, 'openai.key'))
  options.protectedRoots.push(dataDir, keyFile)
  const contextOf = mode !== 'advisory' ? mountUserContext(ctx) : undefined
  const budget = mode === 'openai' ? new DailyBudget({ directory: resolve(dataDir, 'budget'), dailyTokenLimit }) : undefined
  const primaryTokenLimit = config.primaryTokenLimit ?? 250_000
  const secondaryTokenLimit = config.secondaryTokenLimit ?? 2_500_000
  const paidDailyUsd = config.paidDailyUsd ?? 1
  if (![primaryTokenLimit, secondaryTokenLimit].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000)
    || !Number.isFinite(paidDailyUsd) || paidDailyUsd < 0 || paidDailyUsd > 1000) throw new Error('Invalid tier allowance or paid budget.')
  const tiered = mode === 'tiered' ? createTieredReview({ dataDir, primaryTokens: primaryTokenLimit, secondaryTokens: secondaryTokenLimit, paidDailyUsd }) : undefined
  if (tiered) { mountUsageRemote(ctx, tiered.snapshot); ctx.effect(() => () => tiered.stop()) }
  const reviewer = budget || tiered ? createOpenAIReviewer({
    model, timeoutMs: reviewerTimeoutMs, maxOutputTokens,
    apiKey: () => loadInferenceKey(keyFile),
    reserve: tokens => budget!.reserve(tokens),
    settle: (reservation, actual) => budget!.settle(reservation as BudgetReservation, actual),
    ...(tiered ? { routing: tiered.routing } : {}),
  }) : undefined
  type Grant = { fingerprint: string; agent: ToolExecution['agent']; expires: number; source: 'rules' | 'model' | 'human'; contextVersion?: string }
  const admitted = new Map<ToolExecutionToken, Grant>()
  const stopping = new AbortController()
  let active = true
  const counts = { auto: 0, model: 0, human: 0, denied: 0, fallback: 0 }
  let lastReview = 'No independent model review yet.'

  const environmentProblem = (exec: Readonly<ToolExecution>): string | undefined => {
    if (!active || stopping.signal.aborted) return 'Safe Review is stopping; retry after restart.'
    if (!exec.agent) return 'Agentless execution cannot be approved.'
    const mode = ctx.sandboxPolicy.resolve({ session: exec.agent.session }).mode
    if (mode !== 'read-only' && mode !== 'workspace-write') return 'Select Read Only or Workspace Write. Full access is blocked while Safe Review is active.'
    const approval = (ctx.approval.overrideOf(exec.agent.session) ?? ctx.approval.config.policy ?? 'ask')
    if (approval !== 'ask' && exec.agent.session.header.origin !== 'subagent') return 'The parent session must use the ask approval policy.'
    return undefined
  }
  const deny = (reason: string): PreToolDecision => {
    counts.denied++
    return { kind: 'deny', reason: `[Safe Review] ${reason}` }
  }
  ctx.tools.guard(exec => {
    const grant = admitted.get(exec.token)
    admitted.delete(exec.token)
    const problem = environmentProblem(exec)
    if (problem) return `[Safe Review] ${problem}`
    if (!grant || grant.agent !== exec.agent || grant.expires < Date.now() || grant.fingerprint !== digest(exec)) return '[Safe Review] No valid approval for this exact execution.'
    if (exec.signal.aborted) return '[Safe Review] Execution was cancelled.'
    if (grant.contextVersion !== undefined && contextOf?.(exec.agent!.session).version !== grant.contextVersion) return '[Safe Review] User instructions or permissions changed; the earlier approval is invalid.'
    const fresh = assess(exec, options)
    if (fresh.risk === 'high') return `[Safe Review] ${fresh.reason}`
    if (grant.source === 'rules' && fresh.risk !== 'low') return '[Safe Review] Target changed after automatic review.'
    if (grant.source === 'model' && (modelEligibility(exec, fresh, options) || !contextOf?.(exec.agent!.session).complete)) return '[Safe Review] Action is no longer eligible for independent approval.'
    if (grant.source === 'human') {
      const conflict = humanChannelProblem(ctx)
      if (conflict) return `[Safe Review] ${conflict}`
    }
    try { sealApprovedExecution(exec, grant.fingerprint) }
    catch { return '[Safe Review] The approved execution could not be made immutable.' }
    if (grant.source === 'human') counts.human++
    else { counts.auto++; if (grant.source === 'model') counts.model++ }
    return undefined
  })
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const problem = environmentProblem(exec)
    if (problem) return deny(problem)
    let assessment: Assessment = assess(exec, options)
    if (assessment.risk === 'high') return deny(assessment.reason)
    const fingerprint = digest(exec)
    // Other policy listeners retain their veto. The final guard catches a listener
    // which skips this one entirely, irrespective of prepend order.
    const downstream = await next()
    if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
    if (digest(exec) !== fingerprint) return deny('The action changed while another policy was checking it.')
    if (downstream.kind === 'ask') assessment = { risk: 'unknown', reason: 'Another host policy requires confirmation for this call.' }
    const userContext = contextOf?.(exec.agent!.session)
    let source: Grant['source'] = 'rules'
    let needsHuman = assessment.risk !== 'low'
    if (mode !== 'advisory') {
      // Even ordinary writes must respect the user's standing task restrictions.
      needsHuman = true
      const floor = downstream.kind === 'ask' ? assessment.reason : modelEligibility(exec, assessment, options)
      if (!floor && userContext?.complete && reviewer) {
        try {
          const verdict = await reviewer.review({
            toolName: exec.name, arguments: exec.arguments, workspaceRoot: exec.agent!.session.header.cwd!,
            trustedUserMessages: userContext.messages, policyReason: assessment.reason, contextVersion: userContext.version,
          }, AbortSignal.any([exec.signal, stopping.signal]), createHash('sha256').update(JSON.stringify([exec.agent!.session.id, exec.callId, fingerprint, userContext.version])).digest('hex'))
          lastReview = `${verdict.decision}/${verdict.risk}: ${verdict.reason}`
          if (verdict.decision === 'deny' || verdict.risk === 'high') return deny(verdict.reason)
          if (verdict.decision === 'allow' && verdict.risk === 'low') { source = 'model'; needsHuman = false }
          else { assessment = { risk: 'unknown', reason: verdict.reason }; counts.fallback++ }
        } catch { assessment = { risk: 'unknown', reason: 'Independent reviewer unavailable; human confirmation is required.' }; counts.fallback++ }
      } else {
        assessment = { risk: assessment.risk === 'sensitive' ? 'sensitive' : 'unknown', reason: floor ?? userContext?.reason ?? 'Complete verified human instructions are unavailable.' }
        counts.fallback++
      }
    } else if (assessment.risk !== 'low' && (config.advisoryModel ?? true)) {
      assessment = await review(ctx, exec, assessment, reviewerTimeoutMs)
    }
    if (assessment.risk === 'high') return deny(assessment.reason)
    if (exec.signal.aborted || !active) return deny('The call was cancelled.')
    if (userContext && contextOf?.(exec.agent!.session).version !== userContext.version) return deny('User instructions or permissions changed during review; submit a fresh action.')
    if (digest(exec) !== fingerprint) return deny('The action changed during review; the earlier decision is invalid.')
    if (needsHuman) {
      const conflict = humanChannelProblem(ctx)
      if (conflict) return deny(conflict)
      if ((ctx.approval.overrideOf(exec.agent!.session) ?? ctx.approval.config.policy ?? 'ask') !== 'ask') return deny('Delegated or unattended calls cannot request human approval; return to the parent.')
      const signal = AbortSignal.any([exec.signal, stopping.signal, AbortSignal.timeout(approvalTimeoutMs)])
      const outcome = await ctx.approval.request({
        agent: exec.agent!, toolName: exec.name, callId: exec.callId,
        reason: `[Safe Review: ${assessment.risk}] ${assessment.reason} Approve only this exact tool call.`,
        signal,
      })
      if (outcome !== 'allowed-once' || signal.aborted) return deny('Human confirmation was rejected, cancelled, unavailable or expired.')
      const changed = environmentProblem(exec) ?? humanChannelProblem(ctx)
      if (changed) return deny(changed)
      source = 'human'
    }
    if (digest(exec) !== fingerprint) return deny('The action changed during human confirmation.')
    admitted.set(exec.token, { fingerprint, agent: exec.agent, expires: Date.now() + 1000, source, ...(userContext ? { contextVersion: userContext.version } : {}) })
    return { kind: 'allow' }
  }, { prepend: true })
  ctx.on('tools/result', exec => { admitted.delete(exec.token) })
  ctx.inject(['commands'], scope => {
    scope.commands.register({
      name: 'safe-review', description: 'Show Safe Review status and process-lifetime decision counts.',
      handler: async () => {
        let usage = ''
        if (budget) {
          try { const b = await budget.snapshot(); usage = ` Local UTC budget: ${b.charged}/${b.limit} tokens; includes unresolved reservations, not an account-wide free quota check.` }
          catch { usage = ' Local budget storage unavailable; new model approvals fail to human.' }
        }
        if (tiered) {
          try { const b = await tiered.snapshot(); usage = ` Tier: ${b.activeTier}; quota: ${b.status}. ` + b.tiers.map(t => `${t.model}: ${t.localUsedTokens} local tokens; estimated free remaining ${t.allowance?.remainingTokens ?? 'n/a'}`).join('; ') + `; paid local budget remaining $${b.paidBudget?.remainingUsd.toFixed(4)}; account balance: unknown (billing page).` }
          catch { usage = ' Tier accounting unavailable; automatic requests require human confirmation.' }
        }
        return { kind: 'success', text: `Safe Review 0.3.3 active; DSH 0.2.0-rc.2. Mode: ${mode}${reviewer ? ` (${tiered ? 'Astra → Terra → Luna' : model})` : ''}. Auto: ${counts.auto}; model: ${counts.model}; human: ${counts.human}; denied: ${counts.denied}; fallback: ${counts.fallback}.${usage} ${lastReview} ${humanChannelProblem(ctx) ?? 'Native UI approval channel verified.'}` }
      },
    })
  })
  ctx.provide('safeReviewStatus', Object.freeze({ version: '0.3.3', automatic: reviewer ? `contextual ${tiered ? 'three-tier' : model} review inside workspace sandbox` : 'verified ordinary workspace file operations' }))
  ctx.effect(() => () => { active = false; stopping.abort(); admitted.clear() })
}
