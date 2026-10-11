import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { isDirectoryListing } from '../src/directory-listing.js'
import { assess } from '../src/policy.js'
import { modelEligibility } from '../src/model-eligibility.js'

const cleanup: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-directory-listing-')))
  cleanup.push(base)
  const cwd = join(base, 'workspace')
  const home = join(base, 'home')
  const protectedRoot = join(base, 'control-state')
  for (const path of [cwd, home, protectedRoot, join(cwd, 'sub'), join(cwd, 'with space'), join(cwd, '-R')]) mkdirSync(path)
  mkdirSync(join(home, '.dsh', 'profiles', 'desktop'), { recursive: true })
  mkdirSync(join(home, '.ssh'))
  writeFileSync(join(cwd, 'note.txt'), 'An inert fixture. No real private data.')
  writeFileSync(join(protectedRoot, 'settings.json'), '{}')
  vi.stubEnv('HOME', home)
  const options = { protectedRoots: [protectedRoot] }
  const execution = (command: string, args: Record<string, unknown> = {}, name = 'bash') => ({
    name,
    arguments: { command, ...args },
    agent: { session: { header: { cwd } } },
  }) as unknown as Readonly<ToolExecution>
  return { cwd, home, protectedRoot, options, execution }
}

describe('non-recursive directory metadata adapter', () => {
  it('makes the exact reported directory investigation eligible for contextual approval', () => {
    const h = fixture()
    expect(homedir()).toBe(h.home)
    const exec = h.execution('ls -la ~/.dsh/; echo "=== profiles ==="; ls -la ~/.dsh/profiles/; echo "=== desktop ==="; ls -la ~/.dsh/profiles/desktop/')
    expect(isDirectoryListing(exec)).toBe(true)
    const assessment = assess(exec, h.options)
    expect(assessment.risk).toBe('low')
    expect(modelEligibility(exec, assessment, h.options)).toBeUndefined()
  })

  it.each([
    'ls',
    'ls -lah .',
    'ls -a -l sub',
    '/bin/ls -1 sub',
    '/usr/bin/ls -d sub',
    'ls "with space"',
    'ls -- -R',
    'ls sub; echo "another directory"; ls .',
    'ls sub\nls .',
    'ls ~/.ssh/',
    'ls ~',
  ])('recognizes bounded static directory metadata: %s', command => {
    const h = fixture()
    expect(isDirectoryListing(h.execution(command))).toBe(true)
  })

  it('allows a protected absolute directory without weakening its content or mutation floors', () => {
    const h = fixture()
    const listing = h.execution(`ls -la '${h.protectedRoot}'`)
    expect(isDirectoryListing(listing)).toBe(true)
    expect(assess(listing, h.options).risk).toBe('low')
    expect(modelEligibility(listing, assess(listing, h.options), h.options)).toBeUndefined()
    const read = h.execution(`cat '${join(h.protectedRoot, 'settings.json')}'`)
    expect(isDirectoryListing(read)).toBe(false)
    expect(assess(read, h.options).risk).toBe('sensitive')
    const write = h.execution(`echo changed > '${join(h.protectedRoot, 'settings.json')}'`)
    expect(isDirectoryListing(write)).toBe(false)
    expect(assess(write, h.options).risk).toBe('high')
  })

  it.each([
    'ls .; cat note.txt',
    'ls .; rm note.txt',
    'ls .; tee note.txt',
    'ls .; printf "%n" PATH',
    'ls . | cat',
    'ls . | ls sub',
    'ls . && ls sub',
    'ls . || ls sub',
    'ls . &',
    'ls . & ls sub',
    'ls . > note.txt',
    'ls . >> note.txt',
    'ls . < note.txt',
    'ls . 2>&1',
    'ls . >&-',
    'ls . 2>&1>note.txt',
    'ls . > > note.txt',
    'ls . >',
    'ls . &> note.txt',
    'ls . <<< note.txt',
    'ls $(echo .)',
    'ls `echo .`',
    'ls "$HOME"',
    'ls ${HOME}',
    'ls *',
    'ls s?b',
    'ls [a-z]*',
    'ls {sub,.}',
    'ls ~root',
    'ls ~+',
    'ls "~"',
    'ls -R .',
    'ls -laR .',
    'ls --recursive .',
    'ls -L .',
    'ls -H .',
    'ls --unknown-option .',
    'echo "only a heading"',
    'ls .; echo -e escaped',
    'ls .; echo "\\x41"',
    'PATH=/tmp ls .',
    'env ls .',
    'command ls .',
    './ls .',
    '/tmp/ls .',
    '"ls" .',
    'ls .; bash -c "ls ."',
    'ls .\n# comment\ncat note.txt',
  ])('keeps mixed, dynamic or expanded effects off the directory exception: %s', command => {
    expect(isDirectoryListing(fixture().execution(command))).toBe(false)
  })

  it('requires actual directories and rechecks aliases after classification', () => {
    const h = fixture()
    expect(isDirectoryListing(h.execution('ls note.txt'))).toBe(false)
    expect(isDirectoryListing(h.execution('ls absent'))).toBe(false)
    symlinkSync(h.protectedRoot, join(h.cwd, 'alias'))
    expect(isDirectoryListing(h.execution('ls alias'))).toBe(false)
    const exec = h.execution('ls sub')
    expect(isDirectoryListing(exec)).toBe(true)
    rmSync(join(h.cwd, 'sub'), { recursive: true })
    symlinkSync(h.protectedRoot, join(h.cwd, 'sub'))
    expect(isDirectoryListing(exec)).toBe(false)
  })

  it.each([
    { unknown_parameter: true },
    { sandbox_permissions: 'danger-full-access' },
    { run_in_background: true },
    { run_in_background: 'false' },
    { description: 123 },
    { timeoutMs: 0 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { timeoutMs: '1000' },
    { workdir: '..' },
    { workdir: 'absent' },
    { workdir: 'note.txt' },
    { workdir: 123 },
  ])('retains terminal argument validation: %j', args => {
    expect(isDirectoryListing(fixture().execution('ls .', args))).toBe(false)
  })

  it('accepts official ordinary terminal options and respects explicit assessment floors', () => {
    const h = fixture()
    const exec = h.execution('ls .', { workdir: 'sub', timeoutMs: 1000, run_in_background: false, description: 'List the directory.' })
    expect(isDirectoryListing(exec)).toBe(true)
    expect(modelEligibility(exec, { risk: 'sensitive', reason: 'Separate policy requires confirmation.' }, h.options)).toBe('Separate policy requires confirmation.')
    expect(modelEligibility(exec, { risk: 'high', reason: 'Explicit host prohibition.' }, h.options)).toBe('Explicit host prohibition.')
  })

  it('excludes PowerShell, persistent terminal tools, delegated execution and incomplete arguments', () => {
    const h = fixture()
    for (const name of ['pwsh', 'terminal_send', 'terminal_open', 'mcp_bash']) expect(isDirectoryListing(h.execution('ls .', {}, name))).toBe(false)
    const delegated = h.execution('ls .')
    delegated.agent!.session.header.origin = 'subagent'
    expect(isDirectoryListing(delegated)).toBe(false)
    for (const argumentsValue of [null, [], 'ls .', {}, { command: 1 }]) {
      expect(isDirectoryListing({ ...h.execution('ls .'), arguments: argumentsValue } as never)).toBe(false)
    }
    expect(isDirectoryListing({ ...h.execution('ls .'), agent: undefined })).toBe(false)
  })

  it('bounds the number of listing actions and rejects control characters', () => {
    const h = fixture()
    expect(isDirectoryListing(h.execution(Array(17).fill('ls .').join('; ')))).toBe(false)
    expect(isDirectoryListing(h.execution(`ls ${Array(33).fill('.').join(' ')}`))).toBe(false)
    expect(isDirectoryListing(h.execution(`ls .; echo '${'x'.repeat(16_000)}'`))).toBe(false)
    expect(isDirectoryListing(h.execution('ls .\u0000; echo hi'))).toBe(false)
    expect(isDirectoryListing(h.execution('ls .\u001b'))).toBe(false)
  })
})
