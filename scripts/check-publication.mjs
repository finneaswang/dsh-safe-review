/** Inspect tracked files or an npm tarball without echoing matched credential material. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'

const secret = /\b(?:sk-(?:proj-|admin-|svcacct-admin-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/]{64}/i
const personalPath = /\/Users\/(?!synthetic-)[A-Za-z][A-Za-z0-9._-]+\//
const privateFile = /(?:^|\/)(?:node_modules|\.dsh|\.local|outputs|backups|__pycache__)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|daily-budget\.json|tier-budget\.json|usage-accounting\.json)$|\.(?:key|pem|p12|zstd|log)$/i

function inspect(path, body, packed = false) {
  const problems = []
  if (privateFile.test(path) || (!packed && /^(?:lib|dist|coverage)\//.test(path))) problems.push('local-only file')
  if (secret.test(body)) problems.push('credential-like material')
  if (personalPath.test(body)) problems.push('private machine path')
  return problems
}

if (process.argv[2] === '--self-test') {
  assert.deepEqual(inspect('src/example.ts', 'export const value = 1'), [])
  assert.deepEqual(inspect('test/fixture.ts', '/Users/synthetic-review-eval/project'), [])
  assert.ok(inspect('notes.txt', ['sk', 'proj-' + 'x'.repeat(64)].join('-')).includes('credential-like material'))
  assert.ok(inspect('notes.txt', '/Users/' + 'private-example/project').includes('private machine path'))
  assert.ok(inspect('private/openai.key', '').includes('local-only file'))
  assert.ok(inspect('budget/tier-budget.json', '{}').includes('local-only file'))
  assert.ok(inspect('node_modules/example/index.js', '').includes('local-only file'))
  assert.deepEqual(inspect('lib/index.js', '', true), [])
  console.log('Publication guard self-checks passed (8 cases).')
  process.exit(0)
}

const packed = process.argv[2] === '--package'
if (process.argv.length > (packed ? 4 : 2) || (packed && !process.argv[3])) throw new Error('Usage: node scripts/check-publication.mjs [--package FILE | --self-test]')
const files = packed
  ? execFileSync('/usr/bin/tar', ['-tzf', process.argv[3]], { encoding: 'utf8' }).trim().split('\n')
  : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
if (!files.length) throw new Error('No files to inspect. Stage the source files first.')
const failures = []
let checked = 0
for (const file of files) {
  if (packed && file.endsWith('/')) continue
  if (packed && (!file.startsWith('package/') || file.split('/').includes('..'))) throw new Error('Unexpected archive path')
  const path = packed ? file.slice('package/'.length) : file
  if (!packed && !lstatSync(file).isFile()) { failures.push(`${path}: not a regular file`); continue }
  const body = packed
    ? execFileSync('/usr/bin/tar', ['-xOf', process.argv[3], file], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    : readFileSync(file, 'utf8')
  for (const problem of inspect(path, body, packed)) failures.push(`${path}: ${problem}`)
  checked++
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else console.log(`Publication check passed: ${checked} ${packed ? 'packed' : 'tracked'} files; no matched credentials, private machine paths, or local-only files.`)
