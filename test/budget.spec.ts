import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { DailyBudget } from '../src/budget.js'

const faults = vi.hoisted(() => ({ rename: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    rename: async (...args: Parameters<typeof original.rename>) => {
      if (faults.rename) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' })
      return original.rename(...args)
    },
  }
})

const execute = promisify(execFile)
const dirs: string[] = []
const day1 = Date.parse('2026-10-11T23:59:59.000Z')
const day2 = Date.parse('2026-10-12T00:00:00.000Z')
async function fixture(limit = 1000, now = () => day1) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-budget-test-')))
  dirs.push(base)
  const directory = join(base, 'state')
  return { base, directory, budget: new DailyBudget({ directory, dailyTokenLimit: limit, now }) }
}
async function corrupt(directory: string, value: unknown) {
  await writeFile(join(directory, 'daily-budget.json'), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
}
afterEach(async () => {
  faults.rename = false
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('daily reviewer budget', () => {
  it('persists a private charge before returning its receipt and reconciles actual usage', async () => {
    const { directory, budget } = await fixture()
    const reservation = await budget.reserve(400)
    const saved = JSON.parse(await readFile(join(directory, 'daily-budget.json'), 'utf8'))
    expect(saved.charged).toBe(400)
    expect(saved.pending[reservation.id]).toBe(400)
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(directory, 'daily-budget.json'))).mode & 0o777).toBe(0o600)
    await budget.settle(reservation, 75)
    expect(await budget.snapshot()).toEqual({ day: '2026-10-11', limit: 1000, charged: 75, remaining: 925 })
    await budget.settle(reservation, 0)
    expect((await budget.snapshot()).charged).toBe(75)
  })

  it('retains charges across restart, crash and unknown network outcomes', async () => {
    const { directory, budget } = await fixture()
    await budget.reserve(300) // No settlement: the process could have crashed after sending.
    const reservation = await budget.reserve(200)
    await budget.settle(reservation)
    const restarted = new DailyBudget({ directory, dailyTokenLimit: 1000, now: () => day1 })
    expect((await restarted.snapshot()).charged).toBe(500)
    await expect(restarted.reserve(501)).rejects.toThrow('daily token limit reached')
    await restarted.settle(reservation, 0)
    expect((await restarted.snapshot()).charged).toBe(500)
  })

  it('coordinates concurrent instances without overspending', async () => {
    const { directory } = await fixture(500)
    const instances = Array.from({ length: 14 }, () => new DailyBudget({ directory, dailyTokenLimit: 500, now: () => day1 }))
    const results = await Promise.allSettled(instances.map(instance => instance.reserve(100)))
    const accepted = results.filter(result => result.status === 'fulfilled').length
    expect(accepted).toBe(5)
    expect((await instances[0]!.snapshot()).charged).toBe(500)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(9)
  })

  it('concurrent settlements cannot credit the same receipt twice', async () => {
    const { directory, budget } = await fixture()
    const receipt = await budget.reserve(400)
    const other = new DailyBudget({ directory, dailyTokenLimit: 1000, now: () => day1 })
    await Promise.all([budget.settle(receipt, 100), other.settle(receipt, 100)])
    expect((await budget.snapshot()).charged).toBe(100)
  })

  it('uses an exclusive file lock across independent Node processes', async () => {
    const { base, directory } = await fixture(500)
    const source = await readFile(new URL('../src/budget.ts', import.meta.url), 'utf8')
    await writeFile(join(base, 'budget.mjs'), transpileModule(source, {
      compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 },
    }).outputText)
    const code = `import { DailyBudget } from ${JSON.stringify(new URL(`file://${join(base, 'budget.mjs')}`).href)};
      const budget = new DailyBudget({directory: process.argv[1], dailyTokenLimit: 500, now: () => ${day1}});
      let accepted = 0;
      for (let i = 0; i < 4; i++) { try { await budget.reserve(100); accepted++; } catch {} }
      process.stdout.write(String(accepted));`
    const children = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, ['--input-type=module', '-e', code, directory])))
    expect(children.reduce((sum, child) => sum + Number(child.stdout), 0)).toBe(5)
    expect((await new DailyBudget({ directory, dailyTokenLimit: 500, now: () => day1 }).snapshot()).charged).toBe(500)
  })

  it('resets at UTC midnight and an old response cannot credit the new day', async () => {
    let now = day1
    const { budget } = await fixture(1000, () => now)
    const yesterday = await budget.reserve(900)
    now = day2
    await budget.reserve(600)
    await budget.settle(yesterday, 1)
    expect(await budget.snapshot()).toEqual({ day: '2026-10-12', limit: 1000, charged: 600, remaining: 400 })
  })

  it('refuses clock rollback instead of resetting an already used day', async () => {
    let now = day2
    const { budget } = await fixture(1000, () => now)
    await budget.reserve(900)
    now = day1
    await expect(budget.reserve(100)).rejects.toThrow('clock moved behind')
    now = day2
    expect((await budget.snapshot()).charged).toBe(900)
  })

  it('charges an unexpected usage overrun before reporting an error', async () => {
    const { budget } = await fixture(500)
    const receipt = await budget.reserve(400)
    await expect(budget.settle(receipt, 650)).rejects.toThrow('full usage was charged')
    expect(await budget.snapshot()).toMatchObject({ charged: 650, remaining: 0 })
    await expect(budget.reserve(1)).rejects.toThrow('daily token limit reached')
  })

  it('rejects invalid usage and altered receipts without refunding', async () => {
    const { budget } = await fixture()
    const receipt = await budget.reserve(400)
    for (const usage of [-1, 0.5, Infinity, NaN]) await expect(budget.settle(receipt, usage)).rejects.toThrow('invalid reported usage')
    await expect(budget.settle({ ...receipt, reserved: 399 }, 1)).rejects.toThrow('does not match')
    expect((await budget.snapshot()).charged).toBe(400)
    await budget.settle(receipt, 0)
    expect((await budget.snapshot()).charged).toBe(0)
  })

  it.each([0, -1, 0.5, NaN, Infinity, 10_000_001])('rejects invalid daily limit %s', async limit => {
    const { directory } = await fixture()
    expect(() => new DailyBudget({ directory, dailyTokenLimit: limit })).toThrow('daily token limit')
  })

  it.each([0, -1, 0.5, NaN, Infinity, 1001])('rejects invalid reservation %s', async tokens => {
    const { budget } = await fixture()
    await expect(budget.reserve(tokens)).rejects.toThrow('invalid token reservation')
  })

  it.each([
    'broken json',
    { version: 1, day: '2026-02-30', charged: 100, pending: {} },
    { version: 2, day: '2026-10-11', charged: 100, pending: {} },
    { version: 1, day: '2026-10-11', charged: -100, pending: {} },
    { version: 1, day: '2026-10-11', charged: 100, pending: [], extra: true },
    { version: 1, day: '2026-10-11', charged: 100, pending: { untrusted: 10 } },
    { version: 1, day: '2026-10-11', charged: 10, pending: { '00000000-0000-4000-8000-000000000000': 100 } },
  ])('refuses corrupt state instead of granting a fresh allowance: %j', async value => {
    const { directory, budget } = await fixture()
    await budget.reserve(100)
    await corrupt(directory, value)
    await expect(budget.reserve(100)).rejects.toThrow()
    expect(await readFile(join(directory, 'daily-budget.json'), 'utf8')).toBe(typeof value === 'string' ? value : JSON.stringify(value))
  })

  it('refuses oversized state without resetting it', async () => {
    const { directory, budget } = await fixture()
    await budget.snapshot()
    await corrupt(directory, ' '.repeat(1024 * 1024 + 1))
    await expect(budget.reserve(100)).rejects.toThrow('size limit')
  })

  it('fails within a bounded wait and preserves an abandoned lock', async () => {
    const { directory, budget } = await fixture()
    await budget.snapshot()
    const lock = join(directory, 'daily-budget.lock')
    await writeFile(lock, 'abandoned', { mode: 0o600 })
    const start = performance.now()
    await expect(budget.reserve(100)).rejects.toThrow('ledger is locked')
    expect(performance.now() - start).toBeLessThan(1800)
    expect(await readFile(lock, 'utf8')).toBe('abandoned')
  })

  it('rejects a symlink at any directory component', async () => {
    const { base, directory } = await fixture()
    await mkdir(directory, { mode: 0o700 })
    const alias = join(base, 'alias')
    await symlink(directory, alias)
    await expect(new DailyBudget({ directory: join(alias, 'nested'), dailyTokenLimit: 1000 }).reserve(100)).rejects.toThrow('symbolic link')
    await expect(new DailyBudget({ directory: alias, dailyTokenLimit: 1000 }).snapshot()).rejects.toThrow('symbolic link')
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects a shared writable parent without a sticky bit', async () => {
    const { base, budget } = await fixture()
    await chmod(base, 0o777)
    await expect(budget.reserve(100)).rejects.toThrow('unsafe shared writable parent')
    await chmod(base, 0o700)
  })

  it.each(['symbolic', 'hard'])('rejects a %s linked ledger without modifying its target', async kind => {
    const { base, directory, budget } = await fixture()
    await budget.snapshot()
    await rm(join(directory, 'daily-budget.json'))
    const target = join(base, 'target')
    await writeFile(target, 'untouched', { mode: 0o600 })
    if (kind === 'symbolic') await symlink(target, join(directory, 'daily-budget.json'))
    else await link(target, join(directory, 'daily-budget.json'))
    await expect(budget.reserve(100)).rejects.toThrow('privately owned regular files')
    expect(await readFile(target, 'utf8')).toBe('untouched')
  })

  it('does not follow or remove a linked lock file', async () => {
    const { base, directory, budget } = await fixture()
    await budget.snapshot()
    const target = join(base, 'target')
    await writeFile(target, 'untouched', { mode: 0o600 })
    await symlink(target, join(directory, 'daily-budget.lock'))
    await expect(budget.reserve(100)).rejects.toThrow('privately owned regular files')
    expect((await lstat(join(directory, 'daily-budget.lock'))).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('untouched')
  })

  it('rejects non-private directory and ledger permissions', async () => {
    const { directory, budget } = await fixture()
    await budget.snapshot()
    await chmod(directory, 0o755)
    await expect(budget.reserve(100)).rejects.toThrow('mode 0700')
    await chmod(directory, 0o700)
    await chmod(join(directory, 'daily-budget.json'), 0o644)
    await expect(budget.reserve(100)).rejects.toThrow('mode 0600')
  })

  it('does not issue a reservation when atomic persistence fails', async () => {
    const { directory, budget } = await fixture()
    await budget.reserve(100)
    faults.rename = true
    await expect(budget.reserve(200)).rejects.toThrow('fixture disk failure')
    faults.rename = false
    expect((await budget.snapshot()).charged).toBe(100)
    expect(await readdir(directory)).toEqual(['daily-budget.json'])
  })

  it('retains the full charge when persisting a usage refund fails', async () => {
    const { budget } = await fixture()
    const receipt = await budget.reserve(400)
    faults.rename = true
    await expect(budget.settle(receipt, 100)).rejects.toThrow('fixture disk failure')
    faults.rename = false
    expect((await budget.snapshot()).charged).toBe(400)
    await budget.settle(receipt, 100)
    expect((await budget.snapshot()).charged).toBe(100)
  })
})
