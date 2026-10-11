/** Run with the official Desktop Electron executable in Node mode. Never prints credentials. */
import assert from 'node:assert/strict'
import { createUsageCache } from '../lib/usage-cache.js'

assert.ok(process.versions.electron, 'This test must run inside the Desktop Electron runtime.')
assert.ok(process.argv[2], 'Pass the dedicated usage credential file path.')
const cache = createUsageCache(process.argv[2])
try {
  const result = await cache.get()
  assert.ok(result, 'The child accounting worker did not return a valid snapshot.')
  console.log(JSON.stringify({ passed: true, runtime: 'Electron Node mode', electronVersion: process.versions.electron,
    snapshot: result }, null, 2))
} finally { cache.stop() }
