import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
export const inject = ['tools', 'fs', 'sessions', 'safeReviewStatus', 'sandboxPolicy', 'appReady', 'appExit']
export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => { void run(ctx) }))
}
async function run(ctx) {
  try {
    const cwd = process.cwd()
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    const session = ctx.sessions.create(SessionId('packed-plugin-smoke'), { meta: { cwd } })
    session.append('turn/start', { turn: 1 })
    const agent = { session, id: session.id, ctx }
    let seq = 0
    const execute = (name, args) => ctx.tools.execute({ name, arguments: args, callId: ToolCallId(`packed-${seq++}`), agent, signal: new AbortController().signal })
    assert.equal(ctx.safeReviewStatus.version, '0.3.3')
    const ordinary = await execute('write', { file_path: 'packed-output.txt', content: 'packed artifact loaded' })
    assert.equal(ordinary.isError, false, JSON.stringify(ordinary))
    assert.equal(readFileSync(join(cwd, 'packed-output.txt'), 'utf8'), 'packed artifact loaded')
    const protectedResult = await execute('write', { file_path: '.codex/config.toml', content: 'must never be written' })
    assert.equal(protectedResult.isError, true)
    assert.match(JSON.stringify(protectedResult), /Safe Review/)
    assert.equal(existsSync(join(cwd, '.codex/config.toml')), false)
    assert.equal(ctx.sandboxPolicy.resolve({ session }).mode, 'workspace-write')
    writeFileSync(process.env.SAFE_REVIEW_REPORT, JSON.stringify({ passed: true, entry: `dsh --profile ${process.env.SAFE_REVIEW_PROFILE}`, checks: ['packed bundle activated', 'real filesystem write succeeded', 'protected mutation blocked', 'sandbox unchanged'] }, null, 2))
    ctx.appExit(0)
  } catch (error) {
    writeFileSync(process.env.SAFE_REVIEW_REPORT, JSON.stringify({ passed: false, error: String(error) }, null, 2))
    ctx.appExit(1)
  }
}
