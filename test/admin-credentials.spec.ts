import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAdminUsageKey } from '../src/admin-credentials.js'
import { validInferenceKey } from '../src/credentials.js'

const key = ('sk-' + 'admin-SYNTHETIC-NOT-A-REAL-CREDENTIAL-0000')
const directories: string[] = []
async function fixture(value = key) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'admin-usage-test-')))
  directories.push(dir)
  const path = join(dir, 'admin-usage.key')
  await writeFile(path, value, { mode: 0o600 })
  return { dir, path }
}
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })
describe('separate Admin usage credential', () => {
  it('loads its private file and remains forbidden in the inference loader', async () => {
    const { path } = await fixture()
    expect(await loadAdminUsageKey(path)).toBe(key)
    expect(validInferenceKey(key)).toBe(false)
  })
  it('does not fall back to generic or inference environment secrets', async () => {
    vi.stubEnv('OPENAI_ADMIN_KEY', key)
    vi.stubEnv('DSH_SAFE_REVIEW_OPENAI_API_KEY', key)
    await expect(loadAdminUsageKey('/private/tmp/nonexistent-admin-fixture.key')).rejects.toThrow()
  })
  it.each([('sk-' + 'proj-SYNTHETIC-NOT-A-REAL-CREDENTIAL-0000'), 'invalid', 'x'.repeat(1025)])('rejects wrong kind or invalid file without echoing it', async value => {
    const { path } = await fixture(value)
    try { await loadAdminUsageKey(path); throw new Error('Unexpected credential accepted') }
    catch (error) { expect(String(error)).not.toContain(value); expect(String(error)).not.toContain('Unexpected credential accepted') }
  })
  it.each([0o644, 0o666, 0o400])('rejects unsafe file permissions %s', async mode => {
    const { path } = await fixture(); await chmod(path, mode)
    await expect(loadAdminUsageKey(path)).rejects.toThrow('Unsafe usage credential file')
  })
  it('rejects symbolic and hard links', async () => {
    const { path, dir } = await fixture()
    const alias = join(dir, 'alias')
    await symlink(path, alias)
    await expect(loadAdminUsageKey(alias)).rejects.toThrow()
    await link(path, join(dir, 'hard'))
    await expect(loadAdminUsageKey(path)).rejects.toThrow()
  })
})
