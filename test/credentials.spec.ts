import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadInferenceKey, validInferenceKey } from '../src/credentials.js'

// Deliberately synthetic credentials; these tests never read an actual user key.
const key = ('sk-' + 'proj-synthetic-credential-for-tests-000000000000')
const otherKey = ('sk-' + 'proj-another-synthetic-test-credential-11111111')
const directories: string[] = []

async function fixture(content = key) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-credentials-test-')))
  directories.push(directory)
  const file = join(directory, 'openai.key')
  await writeFile(file, content, { mode: 0o600 })
  return { directory, file }
}

beforeEach(() => {
  vi.stubEnv('DSH_SAFE_REVIEW_OPENAI_API_KEY', undefined)
  vi.stubEnv('OPENAI_API_KEY', undefined)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('dedicated inference credential loader', () => {
  it('reads a private ordinary project key file and allows a trailing newline', async () => {
    const { file } = await fixture(`${key}\n`)
    expect(await loadInferenceKey(file)).toBe(key)
  })

  it('uses only the dedicated environment variable when explicitly present', async () => {
    const { file } = await fixture()
    vi.stubEnv('DSH_SAFE_REVIEW_OPENAI_API_KEY', otherKey)
    vi.stubEnv('OPENAI_API_KEY', ('sk-' + 'admin-synthetic-general-admin-000000000000'))
    expect(await loadInferenceKey(file)).toBe(otherKey)
    expect(await loadInferenceKey('/does-not-exist/test-fixture/openai.key')).toBe(otherKey)
  })

  it('never falls back to a generic environment key', async () => {
    const { file } = await fixture()
    vi.stubEnv('OPENAI_API_KEY', otherKey)
    expect(await loadInferenceKey(file)).toBe(key)
    await rm(file)
    await expect(loadInferenceKey(file)).rejects.toThrow()
  })

  it.each(['', 'not-a-key', ` ${key}`, `${key}\n`, ('sk-' + 'admin-synthetic-admin-key-000000000000'), ('sk-' + 'svcacct-admin-synthetic-admin-000000000000')])('rejects an invalid dedicated env credential without reading the file: %s', async value => {
    const { file } = await fixture()
    vi.stubEnv('DSH_SAFE_REVIEW_OPENAI_API_KEY', value)
    await expect(loadInferenceKey(file)).rejects.toThrow('Invalid dedicated inference credential.')
  })

  it.each([
    ('sk-' + 'admin-synthetic-admin-key-000000000000'),
    ('sk-' + 'svcacct-admin-synthetic-admin-000000000000'),
    ('sk-' + 'AdMiN-synthetic-admin-key-000000000000'),
  ])('rejects administration credentials in a file: %s', async value => {
    const { file } = await fixture(value)
    expect(validInferenceKey(value)).toBe(false)
    await expect(loadInferenceKey(file)).rejects.toThrow('normal project inference API key')
  })

  it.each([0o644, 0o666, 0o400, 0o700])('rejects file permissions %s without silently changing them', async mode => {
    const { file } = await fixture()
    await chmod(file, mode)
    await expect(loadInferenceKey(file)).rejects.toThrow('Unsafe credential file.')
  })

  it('rejects a symbolic-link credential file', async () => {
    const { directory, file } = await fixture()
    const alias = join(directory, 'alias.key')
    await symlink(file, alias)
    await expect(loadInferenceKey(alias)).rejects.toThrow('Unsafe credential file.')
    expect(await readFile(file, 'utf8')).toBe(key)
  })

  it('rejects a symbolic link in the parent path', async () => {
    const { directory, file } = await fixture()
    const parent = join(directory, 'real-parent')
    await mkdir(parent, { mode: 0o700 })
    await writeFile(join(parent, 'openai.key'), key, { mode: 0o600 })
    const alias = join(directory, 'parent-alias')
    await symlink(parent, alias)
    await expect(loadInferenceKey(join(alias, 'openai.key'))).rejects.toThrow('Unsafe credential path.')
    expect(await loadInferenceKey(file)).toBe(key)
  })

  it('rejects a hard-linked credential file', async () => {
    const { directory, file } = await fixture()
    await link(file, join(directory, 'alias.key'))
    await expect(loadInferenceKey(file)).rejects.toThrow('Unsafe credential file.')
  })

  it('rejects relative paths and non-file targets', async () => {
    const { directory } = await fixture()
    await expect(loadInferenceKey('openai.key')).rejects.toThrow('Unsafe credential path.')
    await expect(loadInferenceKey(directory)).rejects.toThrow('Unsafe credential file.')
  })

  it.each(['', 'not-a-key', `${key}\n${otherKey}`, 'sk-short'])('rejects invalid file contents without including them in an error: %s', async value => {
    const { file } = await fixture(value)
    await expect(loadInferenceKey(file)).rejects.toThrow('A normal project inference API key is required.')
  })

  it('refuses oversized files before attempting credential parsing', async () => {
    const { file } = await fixture('x'.repeat(1025))
    await expect(loadInferenceKey(file)).rejects.toThrow('Unsafe credential file.')
  })
})
