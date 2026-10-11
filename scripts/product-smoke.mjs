/** Run the packed artifact through the official DSH CLI in a fresh task-local home. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tarball = resolve(process.argv[2] ?? '')
if (!process.argv[2] || !existsSync(tarball)) throw new Error('Pass an existing packed plugin .tgz.')
const installed = process.argv[3] === '--installed'
const base = resolve(project, installed ? '.local/installed-smoke-0.3.3' : '.local/packed-smoke-0.3.3')
mkdirSync(base, { recursive: true })
if (!installed) {
const extracted = join(base, 'unpacked'); mkdirSync(extracted, { recursive: true })
execFileSync('/usr/bin/tar', ['-xzf', tarball, '-C', extracted])
const namespace = join(project, 'node_modules/@finneas'); mkdirSync(namespace, { recursive: true })
const link = join(namespace, 'dsh-safe-review')
if (existsSync(link)) rmSync(link)
symlinkSync(join(extracted, 'package'), link)
// Package's peer imports resolve from the same pinned dependency tree as the host.
const packageModules = join(extracted, 'package/node_modules')
if (!existsSync(packageModules)) symlinkSync(join(project, 'node_modules'), packageModules)
}
const home = installed ? resolve(project, '.local/install-smoke-home-0.3.3') : join(base, 'dsh-home')
const profileName = installed ? 'install-smoke' : 'safe-review-smoke'
const profile = join(home, 'profiles', profileName); mkdirSync(profile, { recursive: true })
if (!installed && !existsSync(join(profile, 'node_modules'))) symlinkSync(join(project, 'node_modules'), join(profile, 'node_modules'))
const core = ['session', 'session-projection', 'system-prompt', 'tools', 'user-approval', 'sandbox-policy', 'fs-sandbox', 'tool-fs']
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-safe-review-smoke', private: true, type: 'module', dependencies: Object.fromEntries([...core.map(x => [`@deepseek-ai/dsh-${x}`, '0.2.0-rc.2']), ['@finneas/dsh-safe-review', '0.3.3']]), dsh: { profile: { bundles: ['@finneas/dsh-safe-review'] } } }, null, 2))
const cwd = join(base, 'workspace'); mkdirSync(cwd, { recursive: true })
const configs = { 'user-approval': { policy: 'ask' }, 'sandbox-policy': { mode: 'workspace-write', workspaceRoot: cwd }, 'fs-sandbox': { cwd } }
writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [
  ...core.map(id => ({ id: `smoke-${id}`, name: `@deepseek-ai/dsh-${id}`, ...(configs[id] ? { config: configs[id] } : {}) })),
  { id: 'product-probe', name: join(project, 'test/fixtures/product-probe.mjs') },
] }], null, 2))
const report = join(base, 'result.json')
if (existsSync(report)) rmSync(report)
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', SAFE_REVIEW_REPORT: report, SAFE_REVIEW_PROFILE: profileName }
const cli = join(project, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const child = spawn(process.execPath, [cli, '--profile', profileName], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', chunk => { output += chunk })
child.stderr.on('data', chunk => { output += chunk })
const timer = setTimeout(() => { child.kill('SIGTERM') }, 20_000)
const code = await new Promise(resolve => child.on('close', resolve))
clearTimeout(timer)
writeFileSync(join(base, 'cli.log'), output)
if (!existsSync(report)) throw new Error(`Product smoke failed (exit ${code}): ${output.slice(-6000)}`)
const result = JSON.parse(readFileSync(report, 'utf8'))
if (!result.passed || code !== 0) throw new Error(result.error ?? `CLI exit ${code}`)
for (const path of ['lib/index.js', 'lib/policy.js', 'lib/reviewer.js', 'lib/vendor/dsh-classifier.js', 'lib/tier-budget.js', 'lib/usage-api.js', 'lib/usage-worker.js', 'lib/usage-cache.js', 'lib/client.js']) {
  const expected = execFileSync('/usr/bin/tar', ['-xOf', tarball, `package/${path}`])
  const actual = readFileSync(join(profile, 'node_modules/@finneas/dsh-safe-review', path))
  if (!expected.equals(actual)) throw new Error(`Installed artifact differs: ${path}`)
}
result.artifactVerified = true
result.tarballSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
writeFileSync(report, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
