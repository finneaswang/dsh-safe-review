/** Three independent official CLI boots, isolated session replay, and controlled approvals. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tarball = resolve(process.argv[2])
mkdirSync(resolve(project, '.local'), { recursive: true })
const base = mkdtempSync(resolve(project, '.local/restart-smoke-'))
const home = join(base, 'home')
const profile = join(home, 'profiles', 'restart-smoke')
const cwd = join(base, 'workspace')
mkdirSync(profile, { recursive: true }); mkdirSync(cwd)
symlinkSync(join(project, 'node_modules'), join(profile, 'node_modules'))
for (const path of ['lib/index.js', 'lib/policy.js', 'lib/reviewer.js']) {
  assert.deepEqual(readFileSync(join(profile, 'node_modules/@finneas/dsh-safe-review', path)),
    execFileSync('/usr/bin/tar', ['-xOf', tarball, `package/${path}`]))
}
const core = ['session', 'session-projection', 'system-prompt', 'tools', 'user-approval', 'sandbox-policy']
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-restart-test', private: true,
  dependencies: Object.fromEntries([...core.map(x => [`@deepseek-ai/dsh-${x}`, '0.2.0-rc.2']), ['@finneas/dsh-safe-review', '0.3.2']]),
  dsh: { profile: { bundles: ['@finneas/dsh-safe-review'] } } }))
const configs = { 'user-approval': { policy: 'ask' }, 'sandbox-policy': { mode: 'workspace-write', workspaceRoot: cwd } }
writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [
  ...core.map(id => ({ id: `restart-${id}`, name: `@deepseek-ai/dsh-${id}`, ...(configs[id] ? { config: configs[id] } : {}) })),
  { id: 'restart-probe', name: join(project, 'test/fixtures/restart-probe.mjs') },
] }]))
const before = readFileSync(join(profile, 'package.json'))
const phases = []
for (const phase of [1, 2, 3]) {
  const report = join(base, `phase-${phase}.json`)
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', RESTART_PHASE: String(phase),
    RESTART_REPORT: report, RESTART_SNAPSHOT: join(base, 'session-snapshot.json') }
  const child = spawn(process.execPath, [join(project, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'restart-smoke'],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', s => { log += s }); child.stderr.on('data', s => { log += s })
  const timer = setTimeout(() => child.kill('SIGTERM'), 20_000)
  const code = await new Promise(r => child.on('close', r)); clearTimeout(timer)
  writeFileSync(join(base, `phase-${phase}.log`), log)
  const result = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(code, 0, JSON.stringify(result)); assert.equal(result.passed, true)
  assert.deepEqual(readFileSync(join(profile, 'package.json')), before)
  phases.push(result)
}
assert.equal(new Set(phases.map(x => x.pid)).size, 3)
const result = { passed: true, date: new Date().toISOString(), base, phases, artifactVerified: true,
  tarballSha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
  scope: 'Three real CLI processes with the packed plugin and official session restore API. Approval UI transport and bash body are controlled fixtures; this does not certify Desktop window behavior.' }
writeFileSync(join(base, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
