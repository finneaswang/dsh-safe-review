/** Narrow metadata-only adapter; the independent reviewer still checks user intent. */
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { isWithin } from './vendor/paths.js'
import { decomposeCommandLine } from './vendor/shell.js'

export function isDirectoryListing(exec: Readonly<ToolExecution>): boolean {
  if (exec.name !== 'bash' || exec.agent?.session.header.origin === 'subagent') return false
  const args = exec.arguments as Record<string, unknown> | null
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !['command', 'description', 'timeoutMs', 'workdir', 'run_in_background'].includes(key))
    || typeof args.command !== 'string' || args.command.length > 16_000
    || (args.description !== undefined && typeof args.description !== 'string')
    || (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0))
    || (args.run_in_background !== undefined && args.run_in_background !== false)) return false
  // The shared lexer drops pipe/background/descriptor operators and does not
  // flag bracket globs. Exclude them before considering its static words.
  if (/[&|<>\[\]\x00-\x08\x0b-\x1f\x7f]/.test(args.command)) return false
  const parsed = decomposeCommandLine(args.command, 'bash')
  if (parsed.kind !== 'segments' || parsed.segments.length > 16) return false
  let cwd: string
  try {
    const workspace = exec.agent?.session.header.cwd
    if (!workspace || !isAbsolute(workspace) || (args.workdir !== undefined && typeof args.workdir !== 'string')) return false
    const root = realpathSync(workspace)
    cwd = resolve(workspace, args.workdir as string ?? '.')
    if (realpathSync(cwd) !== cwd || !isWithin(root, cwd) || !statSync(cwd).isDirectory()) return false
  } catch { return false }
  let listings = 0
  for (const segment of parsed.segments) {
    if (segment.readTargets.length || segment.writeTargets.length
      || segment.words.some(word => word.dynamic || word.glob)) return false
    const [program, ...words] = segment.words
    if (!program || program.quoted) return false
    if (['echo', '/bin/echo', '/usr/bin/echo'].includes(program.text)) {
      // Literal headings are useful between listings. No options or escapes.
      if (words.some(word => word.text.startsWith('-') || /[\\~]/.test(word.text))) return false
      continue
    }
    if (!['ls', '/bin/ls', '/usr/bin/ls'].includes(program.text)) return false
    listings++
    let options = true
    const targets: string[] = []
    for (const word of words) {
      if (options && word.text === '--') { options = false; continue }
      if (options && word.text.startsWith('-')) {
        // Common macOS/Linux display flags; recursive and link-following flags
        // deliberately retain the normal review path.
        if (!/^-[aAlhd1FtSr]+$/.test(word.text)) return false
        continue
      }
      let target = word.text
      if (target.startsWith('~')) {
        // Only an unquoted current-user home prefix has an unambiguous meaning.
        if (word.quoted || (target !== '~' && !target.startsWith('~/'))) return false
        target = resolve(homedir(), target === '~' ? '.' : target.slice(2))
      }
      targets.push(resolve(cwd, target))
    }
    if (!targets.length) targets.push(cwd)
    if (targets.length > 32) return false
    try {
      // Confirm actual directories without reading their contents. Aliases keep
      // the existing review path; all checks run again in the final guard.
      if (targets.some(target => realpathSync(target) !== target || !statSync(target).isDirectory())) return false
    } catch { return false }
  }
  return listings > 0
}
