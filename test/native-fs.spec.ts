import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Approval from '@deepseek-ai/dsh-user-approval'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import * as Gate from '../src/index.js'

describe('real sandboxed filesystem tools', () => {
  it('writes, reads and edits actual files while preserving the host sandbox', async () => {
    const base = realpathSync(mkdtempSync(resolve('../native-fs-')))
    const cwd = join(base, 'workspace'); mkdirSync(cwd)
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections); await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime); await ctx.plugin(Approval, { policy: 'ask' })
      await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: cwd })
      await ctx.plugin(SandboxedFileSystem, { cwd }); await ctx.plugin(ToolFs); await ctx.plugin(Gate)
      const session = ctx.sessions.create(SessionId('native-fs'), { meta: { cwd } })
      session.append('turn/start', { turn: 1 })
      const agent = { session, id: session.id, ctx } as never
      let id = 0
      const run = (name: string, args: unknown) => ctx.tools.execute({ name, arguments: args, callId: ToolCallId(`native-${id++}`), agent, signal: new AbortController().signal })
      expect((await run('write', { file_path: 'output.txt', content: 'first' })).isError).toBe(false)
      expect(readFileSync(join(cwd, 'output.txt'), 'utf8')).toBe('first')
      expect((await run('read', { file_path: 'output.txt' })).isError).toBe(false)
      expect((await run('edit', { file_path: 'output.txt', old_string: 'first', new_string: 'second' })).isError).toBe(false)
      expect(readFileSync(join(cwd, 'output.txt'), 'utf8')).toBe('second')
      expect((await run('write', { file_path: '../escape.txt', content: 'escape' })).isError).toBe(true)
      expect(existsSync(join(base, 'escape.txt'))).toBe(false)
      // Test the actual DSH filesystem fence independently of our pre-execute gate.
      await expect(ctx.fs.writeText(await ctx.fs.resolve(join(base, 'outside.txt')), 'outside')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(existsSync(join(base, 'outside.txt'))).toBe(false)
      session.append('sandbox/mode', { mode: 'read-only' })
      expect((await run('write', { file_path: 'blocked.txt', content: 'blocked' })).isError).toBe(true)
      expect(existsSync(join(cwd, 'blocked.txt'))).toBe(false)
    } finally { await ctx.fiber.dispose(); rmSync(base, { recursive: true, force: true }) }
  })
})
