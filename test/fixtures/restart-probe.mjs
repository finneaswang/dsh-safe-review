/** Isolated CLI lifecycle probe. Native UI transport is replaced by a controlled queue. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as OfficialRemotes from '@deepseek-ai/dsh-api-remotes'

export const inject = ['tools', 'sessions', 'approval', 'safeReviewStatus', 'sandboxPolicy', 'appReady', 'appExit']
export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => { void run(ctx) }))
}
async function run(ctx) {
  const phase = Number(process.env.RESTART_PHASE)
  const checks = []
  try {
    const id = SessionId('restart-approval-probe')
    let session
    if (phase === 1) {
      session = ctx.sessions.create(id, { meta: { cwd: process.cwd() } })
      session.append('sandbox/mode', { mode: 'workspace-write' })
      session.append('approval/policy', { policy: 'ask' })
    } else {
      const saved = JSON.parse(readFileSync(process.env.RESTART_SNAPSHOT, 'utf8'))
      session = ctx.sessions.prepare(id, {
        meta: saved.header, seed: saved.events, inheritedEventCount: 0, eventState: 'detached',
      })
      ctx.effect(() => ctx.sessions.enter(session))
      ctx.sessions.announce(session)
    }
    session.append('turn/start', { turn: phase })
    const agent = { session, id, ctx }
    let bodyCalls = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'bash', description: 'Inert lifecycle fixture: never executes a shell program.', parameters: {},
      async execute() { bodyCalls++; return [{ type: 'text', text: 'inert body reached' }] },
    }))
    const requests = []
    const waiters = []
    ctx.provide('typertGateway', {
      registerRemoteEvents(source) {
        const controller = new AbortController()
        const iterator = source(controller.signal)
        void (async () => {
          try { for await (const dispatch of iterator) {
            if (dispatch.event !== 'approval/request') continue
            requests.push(dispatch.request)
            waiters.push(value => dispatch.resolve({ kind: 'result', value }))
          } } catch { /* Expected on teardown. */ }
        })()
        return () => controller.abort()
      },
    })
    await ctx.plugin(OfficialRemotes)
    const execute = (signal = new AbortController().signal) => ctx.tools.execute({
      name: 'bash', arguments: { command: "printf 'same-call'" },
      callId: ToolCallId('same-id-in-every-process'), agent, signal,
    })
    const waitForRequest = async () => {
      for (let n = 0; n < 200 && !waiters.length; n++) await new Promise(r => setTimeout(r, 5))
      assert.equal(waiters.length, 1, 'The call must wait at the approval queue.')
    }
    assert.equal(ctx.safeReviewStatus.version, '0.3.3')
    if (phase < 3) {
      assert.equal(ctx.sandboxPolicy.resolve({ session }).mode, 'workspace-write')
      assert.equal(ctx.approval.overrideOf(session), 'ask')
      checks.push('restored workspace-write and ask')
      const call = execute()
      await waitForRequest()
      assert.equal(bodyCalls, 0)
      checks.push('same action and call ID require a fresh approval before body')
      waiters.shift()(phase === 1 ? 'allowed-once' : 'rejected')
      const result = await call
      assert.equal(result.isError, phase === 2)
      assert.equal(bodyCalls, phase === 1 ? 1 : 0)
      checks.push(phase === 1 ? 'one-time approval executes exactly one inert body' : 'rejection never executes the inert body')
      if (phase === 2) {
        const controller = new AbortController()
        const cancelled = execute(controller.signal)
        await waitForRequest()
        controller.abort(new Error('isolated cancellation test'))
        assert.equal((await cancelled).isError, true)
        assert.equal(bodyCalls, 0)
        checks.push('cancelled approval never executes the inert body')
        // Deliberately seed unsafe state only inside the disposable profile.
        session.append('sandbox/mode', { mode: 'danger-full-access' })
      }
    } else {
      assert.equal(ctx.sandboxPolicy.resolve({ session }).mode, 'danger-full-access')
      const result = await execute()
      assert.equal(result.isError, true)
      assert.match(JSON.stringify(result), /Full access is blocked/)
      assert.equal(requests.length, 0)
      assert.equal(bodyCalls, 0)
      checks.push('restored Full access is denied before approval and body')
    }
    const events = Array.from({ length: session.seq }, (_, n) => session.eventAt(SessionSeq(n)))
    writeFileSync(process.env.RESTART_SNAPSHOT, JSON.stringify({ header: session.header, events }))
    writeFileSync(process.env.RESTART_REPORT, JSON.stringify({ passed: true, phase, pid: process.pid, checks, bodyCalls, approvalRequests: requests.length }, null, 2))
    ctx.appExit(0)
  } catch (error) {
    writeFileSync(process.env.RESTART_REPORT, JSON.stringify({ passed: false, phase, checks, error: String(error), stack: error?.stack }, null, 2))
    ctx.appExit(1)
  }
}
