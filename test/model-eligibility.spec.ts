import { afterEach, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assess, type PolicyOptions } from '../src/policy.js'
import { modelEligibility } from '../src/model-eligibility.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture(protectedInside = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-eligibility-test-')))
  directories.push(base)
  const cwd = join(base, 'workspace')
  mkdirSync(cwd)
  mkdirSync(join(cwd, 'sub'))
  writeFileSync(join(cwd, 'note.txt'), 'ordinary project note')
  const protectedRoot = join(protectedInside ? cwd : base, 'review-state')
  mkdirSync(protectedRoot)
  writeFileSync(join(protectedRoot, 'config.txt'), 'synthetic credential fixture, never an actual key')
  const options: PolicyOptions = { protectedRoots: [protectedRoot] }
  const execution = (command: string, args = {}, name = 'bash') => ({
    name, arguments: { command, ...args }, agent: { session: { header: { cwd } } },
  }) as unknown as Readonly<ToolExecution>
  const eligible = (command: string, args = {}, name = 'bash') => {
    const exec = execution(command, args, name)
    return modelEligibility(exec, assess(exec, options), options)
  }
  return { cwd, base, protectedRoot, options, execution, eligible }
}

describe('independent reviewer local eligibility floors', () => {
  it.each([
    "printf 'approval probe\\n'",
    'cat note.txt',
    'wc -l note.txt',
    "printf 'new note' > generated.txt",
    'mkdir generated',
    "rg 'ordinary' note.txt",
    'find . -name note.txt',
    'cat note.txt | wc -c',
  ])('keeps transparent project operation eligible for contextual judgment: %s', command => {
    expect(fixture().eligible(command)).toBeUndefined()
  })

  it.each([
    'python -c \'import os; print(os.environ)\'',
    "node -e 'console.log(process.env)'",
    'python3 helper.py',
    'node --test test.js',
    'npm test',
    'pnpm run build',
    'make test',
    'git status',
    'bash -c "cat note.txt"',
    'env',
    'printenv',
    'set',
    'source project.sh',
    './local-program',
    'PATH=/tmp cat note.txt',
    'xargs cat',
    'awk \'BEGIN { system("printenv") }\'',
    'find . -exec python helper.py \\;',
    'find . -delete',
    'rg --pre=./filter foo note.txt',
    'cat "$TARGET"',
    'cat $(printf note.txt)',
    'cat *.txt',
    'cat ~/notes.txt',
    'printf hello &',
    'cat /etc/hosts',
  ])('requires human confirmation for executable or incomplete effects: %s', command => {
    expect(fixture().eligible(command)).toBeTypeOf('string')
  })

  it('preserves DSH terminal parameter names and working-directory checks', () => {
    const h = fixture()
    expect(h.eligible('pwd', { timeoutMs: 1000, workdir: 'sub', run_in_background: false })).toBeUndefined()
    expect(h.eligible('pwd', { timeout: 1000 })).toMatch(/Unrecognized/)
    expect(h.eligible('pwd', { run_in_background: true })).toMatch(/Background/)
    expect(h.eligible('pwd', { workdir: '..' })).toMatch(/workspace directory/)
    expect(h.eligible('pwd', { timeoutMs: 0 })).toMatch(/timeout/)
  })

  it('does not mistake PowerShell environment providers for ordinary paths', () => {
    expect(fixture().eligible('ls env:', {}, 'pwsh')).toMatch(/PowerShell/)
  })

  it('holds custom credential and plugin roots to a local human floor', () => {
    const h = fixture(true)
    expect(h.eligible('cat review-state/config.txt')).toMatch(/protected/i)
    expect(h.eligible(`cat '${join(h.protectedRoot, 'config.txt')}'`)).toMatch(/protected/i)
    expect(h.eligible('cat ../review-state/config.txt', { workdir: 'sub' })).toMatch(/protected/i)
    expect(h.eligible('rg synthetic')).toMatch(/protected/i)
    expect(h.eligible('find . -name config.txt')).toMatch(/protected/i)
    expect(h.eligible('cat note.txt')).toBeUndefined()
  })

  it.each([
    'printf bad > review-state/config.txt',
    'tee review-state/config.txt',
    'cp note.txt review-state/config.txt',
    'rm -rf review-state',
    'mv review-state elsewhere',
    'chmod 777 review-state',
    'dd if=note.txt of=review-state/config.txt',
    'find . -fprint review-state/config.txt',
    'find review-state -delete',
  ])('hard denies explicit mutations of a custom protected root: %s', command => {
    const h = fixture(true)
    expect(assess(h.execution(command), h.options).risk).toBe('high')
    expect(h.eligible(command)).toBeTypeOf('string')
  })

  it('hard denies an interpreter mutation naming an absolute protected path', () => {
    const h = fixture(true)
    const command = `python3 -c "open('${join(h.protectedRoot, 'config.txt')}', 'w').write('bad')"`
    expect(assess(h.execution(command), h.options).risk).toBe('high')
  })

  it('detects resolved protected aliases, including new files below a linked directory', () => {
    const h = fixture()
    symlinkSync(h.protectedRoot, join(h.cwd, 'alias'))
    expect(h.eligible('cat alias/config.txt')).toMatch(/protected/i)
    expect(assess(h.execution('printf bad > alias/new.txt'), h.options).risk).toBe('high')
  })

  it('requires confirmation for ordinary aliases and shared hard links', () => {
    const h = fixture()
    symlinkSync(join(h.cwd, 'note.txt'), join(h.cwd, 'alias.txt'))
    expect(h.eligible('cat alias.txt')).toMatch(/alias/i)
    linkSync(join(h.cwd, 'note.txt'), join(h.cwd, 'linked.txt'))
    expect(h.eligible('cat linked.txt')).toMatch(/alias/i)
    symlinkSync(join(h.cwd, 'sub'), join(h.cwd, 'linked-dir'))
    expect(h.eligible('printf bad > linked-dir/new.txt')).toMatch(/alias/i)
  })

  it('never overrides a sensitive assessment or delegates unverified tools', () => {
    const h = fixture()
    expect(modelEligibility(h.execution('printf ok'), { risk: 'sensitive', reason: 'host floor' }, h.options)).toBe('host floor')
    expect(h.eligible('safe', {}, 'mcp_custom')).toMatch(/verified adapter/)
  })

  it.each(['https://127.0.0.1/', 'https://172.16.0.1/', 'https://[::1]/', 'https://localhost/', 'https://metadata.internal/', 'https://example.com/?token=opaque'])('keeps private or incomplete browser targets human: %s', url => {
    const h = fixture()
    const exec = { ...h.execution('unused'), name: 'browser', arguments: { action: 'navigate', url } }
    expect(modelEligibility(exec, { risk: 'unknown', reason: 'browser review' }, h.options)).toBeTypeOf('string')
  })

  it('allows a complete ordinary public navigation to reach contextual judgment', () => {
    const h = fixture()
    const exec = { ...h.execution('unused'), name: 'browser', arguments: { action: 'navigate', url: 'https://example.com/docs' } }
    expect(modelEligibility(exec, { risk: 'unknown', reason: 'browser review' }, h.options)).toBeUndefined()
  })
})
