/** Loaded only by the separate usage-query process, never by the reviewer. */
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export function validAdminUsageKey(value: string): boolean {
  return /^sk-(?:admin|svcacct-admin)-[A-Za-z0-9_-]{16,512}$/.test(value)
}

export async function loadAdminUsageKey(path: string): Promise<string> {
  if (!isAbsolute(path) || realpathSync(dirname(path)) !== resolve(dirname(path))) throw new Error('Unsafe usage credential path.')
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
    || (process.getuid && before.uid !== process.getuid()) || before.size > 1024) throw new Error('Unsafe usage credential file.')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600) throw new Error('Usage credential file changed.')
    const value = readFileSync(fd, 'utf8').trim()
    if (!validAdminUsageKey(value)) throw new Error('A dedicated Admin usage credential is required.')
    return value
  } finally { closeSync(fd) }
}
