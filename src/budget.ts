import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export interface BudgetReservation { id: string; day: string; reserved: number }
export interface BudgetSnapshot { day: string; limit: number; charged: number; remaining: number }
export interface DailyBudgetOptions { directory: string; dailyTokenLimit: number; now?: () => number }

interface Ledger {
  version: 1
  day: string
  charged: number
  pending: Record<string, number>
}

const FILE = 'daily-budget.json'
const LOCK = 'daily-budget.lock'
const MAX_BYTES = 1024 * 1024
const MAX_PENDING = 10_000
const MAX_LIMIT = 10_000_000
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

function fail(reason: string): never { throw new Error(`Safe Review budget: ${reason}`) }
function errno(error: unknown, code: string): boolean { return (error as NodeJS.ErrnoException)?.code === code }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino }
function validDay(day: unknown): day is string {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
    && !Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))
    && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day
}
function safeFile(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    fail('ledger files must be privately owned regular files with mode 0600 and one link')
  }
}

/** A local cap, not proof of the organization-wide free-token balance. */
export class DailyBudget {
  readonly directory: string
  readonly dailyTokenLimit: number
  private readonly now: () => number

  constructor(options: DailyBudgetOptions) {
    if (!options.directory || !isAbsolute(options.directory) || options.directory.includes('\0')) fail('directory must be an absolute path')
    if (!integer(options.dailyTokenLimit) || options.dailyTokenLimit < 1 || options.dailyTokenLimit > MAX_LIMIT) {
      fail(`daily token limit must be an integer between 1 and ${MAX_LIMIT}`)
    }
    this.directory = resolve(options.directory)
    this.dailyTokenLimit = options.dailyTokenLimit
    this.now = options.now ?? Date.now
  }

  /** Persist the worst-case charge before a network request is sent. */
  async reserve(tokens: number): Promise<BudgetReservation> {
    if (!integer(tokens) || tokens < 1 || tokens > this.dailyTokenLimit) fail('invalid token reservation')
    return this.transaction(async ledger => {
      if (ledger.charged > this.dailyTokenLimit - tokens) fail('daily token limit reached')
      if (Object.keys(ledger.pending).length >= MAX_PENDING) fail('too many unresolved reservations')
      const reservation = { id: randomUUID(), day: ledger.day, reserved: tokens }
      ledger.charged += tokens
      ledger.pending[reservation.id] = tokens
      return { result: reservation, changed: true }
    })
  }

  /** Unknown outcomes retain their full charge; they must never produce a refund. */
  async settle(reservation: BudgetReservation, actualTokens?: number): Promise<void> {
    if (!reservation || !UUID.test(reservation.id) || !validDay(reservation.day)
      || !integer(reservation.reserved) || reservation.reserved < 1) fail('invalid reservation receipt')
    if (actualTokens !== undefined && !integer(actualTokens)) fail('invalid reported usage')
    const overrun = await this.transaction(async ledger => {
      if (reservation.day < ledger.day) return { result: false, changed: false }
      if (reservation.day !== ledger.day) fail('reservation belongs to a future UTC day')
      const pending = ledger.pending[reservation.id]
      // Already-settled receipts cannot refund a second time.
      if (pending === undefined) return { result: false, changed: false }
      if (pending !== reservation.reserved) fail('reservation receipt does not match the ledger')
      const actual = actualTokens ?? pending
      const charged = ledger.charged - pending + actual
      if (!integer(charged)) fail('reported usage is too large to account safely')
      ledger.charged = charged
      delete ledger.pending[reservation.id]
      return { result: actual > pending, changed: true }
    })
    if (overrun) fail('reported usage exceeded its reservation; the full usage was charged')
  }

  async snapshot(): Promise<BudgetSnapshot> {
    return this.transaction(async ledger => ({
      result: { day: ledger.day, limit: this.dailyTokenLimit, charged: ledger.charged, remaining: Math.max(0, this.dailyTokenLimit - ledger.charged) },
      changed: false,
    }))
  }

  private day(): string {
    const timestamp = this.now()
    if (!integer(timestamp)) fail('invalid clock')
    const date = new Date(timestamp)
    if (Number.isNaN(date.valueOf())) fail('invalid clock')
    const day = date.toISOString().slice(0, 10)
    if (!validDay(day)) fail('invalid UTC day')
    return day
  }

  private async directoryInfo(create: boolean): Promise<Stats> {
    const root = parse(this.directory).root
    let path = root
    let info = await lstat(path)
    const components = this.directory.slice(root.length).split(sep).filter(Boolean)
    if (!components.length) fail('the filesystem root cannot be used as a budget directory')
    for (const component of components) {
      path = join(path, component)
      try { info = await lstat(path) } catch (error) {
        if (!create || !errno(error, 'ENOENT')) throw error
        try { await mkdir(path, { mode: 0o700 }) } catch (mkdirError) {
          if (!errno(mkdirError, 'EEXIST')) throw mkdirError
        }
        info = await lstat(path)
      }
      if (!info.isDirectory() || info.isSymbolicLink()) fail('directory path contains a non-directory or symbolic link')
      // Sticky shared temp directories are safe to traverse; other writable
      // shared parents would let a different user replace our private directory.
      if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) fail('directory path contains an unsafe shared writable parent')
    }
    if ((info.mode & 0o7777) !== 0o700 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      fail('budget directory must be privately owned with mode 0700')
    }
    return info
  }

  private async checkDirectory(expected: Stats): Promise<void> {
    if (!sameFile(expected, await this.directoryInfo(false))) fail('budget directory changed during the operation')
  }

  private async lock(directory: Stats): Promise<FileHandle> {
    const path = join(this.directory, LOCK)
    for (let attempt = 0; attempt < 26; attempt++) {
      await this.checkDirectory(directory)
      try {
        const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try { safeFile(await handle.stat()); return handle } catch (error) { await handle.close(); throw error }
      } catch (error) {
        if (!errno(error, 'EEXIST')) throw error
        // An abandoned lock is deliberately not deleted automatically.
        try { safeFile(await lstat(path)) } catch (statError) {
          if (errno(statError, 'ENOENT')) continue
          throw statError
        }
        if (attempt === 25) fail('ledger is locked; retry later or inspect an abandoned lock manually')
        await delay(20)
      }
    }
    return fail('unable to lock the ledger')
  }

  private async readLedger(): Promise<Ledger | undefined> {
    const path = join(this.directory, FILE)
    let before: Stats
    try { before = await lstat(path) } catch (error) { if (errno(error, 'ENOENT')) return undefined; throw error }
    safeFile(before)
    if (before.size > MAX_BYTES) fail('ledger exceeds its size limit')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat()
      safeFile(opened)
      if (!sameFile(before, opened)) fail('ledger changed while opening')
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const after = await handle.stat()
      safeFile(after)
      if (bytesRead > MAX_BYTES || after.size !== bytesRead || !sameFile(opened, await lstat(path))) fail('ledger changed while reading')
      let value: unknown
      try { value = JSON.parse(buffer.toString('utf8', 0, bytesRead)) } catch { fail('ledger is corrupt; refusing to reset usage') }
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid ledger')
      const ledger = value as Record<string, unknown>
      if (Object.keys(ledger).sort().join(',') !== 'charged,day,pending,version' || ledger.version !== 1
        || !validDay(ledger.day) || !integer(ledger.charged) || !ledger.pending || typeof ledger.pending !== 'object' || Array.isArray(ledger.pending)) fail('invalid ledger schema')
      const pending = Object.entries(ledger.pending)
      if (pending.length > MAX_PENDING) fail('too many unresolved ledger reservations')
      let reserved = 0
      for (const [id, tokens] of pending) {
        if (!UUID.test(id) || !integer(tokens) || tokens < 1) fail('invalid ledger reservation')
        reserved += tokens
        if (!integer(reserved)) fail('invalid ledger total')
      }
      if (reserved > ledger.charged) fail('ledger total is less than its reservations')
      return value as Ledger
    } finally { await handle.close() }
  }

  private async writeLedger(ledger: Ledger, directory: Stats): Promise<void> {
    const path = join(this.directory, FILE)
    const temporary = join(this.directory, `.daily-budget-${randomUUID()}.tmp`)
    const text = `${JSON.stringify(ledger)}\n`
    if (Buffer.byteLength(text) > MAX_BYTES) fail('ledger exceeds its size limit')
    await this.checkDirectory(directory)
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    const identity = await handle.stat()
    let moved = false
    try {
      safeFile(identity)
      await handle.writeFile(text, 'utf8')
      await handle.sync()
      await this.checkDirectory(directory)
      try { safeFile(await lstat(path)) } catch (error) { if (!errno(error, 'ENOENT')) throw error }
      await rename(temporary, path)
      moved = true
      // Persist the rename as well as the file contents before exposing a receipt.
      const parent = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        if (!sameFile(directory, await parent.stat())) fail('budget directory changed during persistence')
        await parent.sync()
      } finally { await parent.close() }
    } finally {
      await handle.close()
      if (!moved) {
        await this.checkDirectory(directory)
        try {
          const current = await lstat(temporary)
          safeFile(current)
          if (!sameFile(identity, current)) fail('temporary ledger changed; refusing to remove it')
          await unlink(temporary)
        } catch (error) { if (!errno(error, 'ENOENT')) throw error }
      }
    }
  }

  private async transaction<T>(fn: (ledger: Ledger) => Promise<{ result: T; changed: boolean }>): Promise<T> {
    const directory = await this.directoryInfo(true)
    const lock = await this.lock(directory)
    const identity = await lock.stat()
    try {
      await this.checkDirectory(directory)
      const day = this.day()
      let ledger = await this.readLedger()
      if (ledger && ledger.day > day) fail('clock moved behind the ledger day; refusing to reset usage')
      const reset = !ledger || ledger.day !== day
      if (reset) ledger = { version: 1, day, charged: 0, pending: {} }
      const { result, changed } = await fn(ledger!)
      if (reset || changed) await this.writeLedger(ledger!, directory)
      return result
    } finally {
      await lock.close()
      await this.checkDirectory(directory)
      const current = await lstat(join(this.directory, LOCK))
      safeFile(current)
      if (!sameFile(identity, current)) fail('lock changed during the operation; refusing to remove it')
      await unlink(join(this.directory, LOCK))
    }
  }
}
