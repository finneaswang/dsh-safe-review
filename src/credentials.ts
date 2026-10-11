/** Dedicated inference credentials; never persist or report a key in plugin configuration. */
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export function validInferenceKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]{16,512}$/.test(value) && !/^sk-(?:admin|svcacct-admin)-/i.test(value)
}

export async function loadInferenceKey(path: string): Promise<string> {
  const environment = process.env.DSH_SAFE_REVIEW_OPENAI_API_KEY
  if (environment !== undefined) {
    if (!validInferenceKey(environment)) throw new Error('Invalid dedicated inference credential.')
    return environment
  }
  // Canonical parent prevents a credential reference being redirected through a symlink.
  if (!isAbsolute(path) || realpathSync(dirname(path)) !== resolve(dirname(path))) throw new Error('Unsafe credential path.')
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
    || (process.getuid && before.uid !== process.getuid()) || before.size > 1024) throw new Error('Unsafe credential file.')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600) throw new Error('Credential file changed.')
    const value = readFileSync(fd, 'utf8').trim()
    if (!validInferenceKey(value)) throw new Error('A normal project inference API key is required.')
    return value
  } finally { closeSync(fd) }
}
