/** Local floors remain authoritative even if an independent model returns allow. */
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { protectedShellAssessment, type Assessment, type PolicyOptions } from './policy.js'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { isWithin } from './vendor/paths.js'
import { decomposeCommandLine } from './vendor/shell.js'

export function modelEligibility(exec: Readonly<ToolExecution>, assessment: Assessment, options: PolicyOptions = { protectedRoots: [] }): string | undefined {
  if (assessment.risk === 'high' || assessment.risk === 'sensitive') return assessment.reason
  const args = exec.arguments as Record<string, unknown> | null
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Complete structured arguments are required.'
  if (exec.agent?.session.header.origin === 'subagent') return 'Delegated execution requires parent review.'
  if (['read', 'write', 'edit'].includes(exec.name)) {
    return assessment.risk === 'low' ? undefined : 'Only verified ordinary file targets may receive model approval.'
  }
  if (['bash', 'pwsh'].includes(exec.name)) {
    if (typeof args.command !== 'string' || !args.command.trim()) return 'The complete terminal command is required.'
    if (Object.keys(args).some(k => !['command', 'description', 'timeoutMs', 'workdir', 'run_in_background'].includes(k))) return 'Unrecognized terminal parameters require confirmation.'
    if (args.description !== undefined && typeof args.description !== 'string') return 'Invalid terminal description.'
    if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) return 'Invalid terminal timeout.'
    if (args.run_in_background !== undefined && args.run_in_background !== false) return 'Background processes require confirmation.'
    let workingDirectory: string
    try {
      const cwd = exec.agent?.session.header.cwd
      if (!cwd || (args.workdir !== undefined && typeof args.workdir !== 'string')) return 'A verified working directory is required.'
      const root = realpathSync(cwd)
      const requested = resolve(cwd, args.workdir as string ?? '.')
      const actual = realpathSync(requested)
      if (actual !== requested || !isWithin(root, actual) || !statSync(actual).isDirectory()) return 'Working directory must be an ordinary workspace directory.'
      workingDirectory = actual
    } catch { return 'The working directory cannot be verified.' }
    const command = args.command
    const shell = exec.name === 'pwsh' ? 'pwsh' : 'bash'
    const protectedShell = protectedShellAssessment(command, workingDirectory, shell, options)
    if (protectedShell) return protectedShell.reason
    if (exec.name === 'pwsh') return 'PowerShell providers and aliases require human confirmation until a verified adapter is available.'
    const parsed = decomposeCommandLine(command, shell)
    if (parsed.kind !== 'segments') return 'Opaque shell syntax requires human confirmation.'
    if (/(?:^|[^&])&(?:[^&]|$)/.test(command)) return 'Background execution and descriptor indirection require confirmation.'
    // Restrict automatic review to transparent primitives. Test runners, build
    // tools, interpreters and package scripts execute unseen project code and
    // can read inherited environment variables even inside workspace-write.
    const primitives = new Set(['printf', 'echo', 'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'rg', 'grep', 'find', 'mkdir', 'touch', 'cp', 'mv', 'tee', 'date', 'true', 'false'])
    for (const segment of parsed.segments) {
      const words = [...segment.words, ...segment.readTargets, ...segment.writeTargets]
      if (words.some(word => word.dynamic || word.glob || word.text.startsWith('~'))) return 'Dynamic shell expansion requires human confirmation.'
      const executable = segment.words[0]?.text
      if (!executable || !primitives.has(basename(executable))
        || (executable.includes('/') && !['/bin', '/usr/bin'].includes(dirname(executable)))) return 'Scripts, interpreters, wrappers and unverified programs require human confirmation.'
      const name = basename(executable)
      if (name === 'find' && segment.words.some(word => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(word.text))) return 'Executable or mutating find actions require confirmation.'
      if (name === 'rg' && segment.words.some(word => /^--(?:pre|hostname-bin)(?:=|$)/.test(word.text))) return 'External search helpers require confirmation.'
      // Explicit file arguments must not be a path alias or an outside read.
      // This is a local evidence check, not a guarantee about executable code.
      for (const word of [...segment.words.slice(1), ...segment.readTargets, ...segment.writeTargets]) {
        const value = word.text.startsWith('-') && word.text.includes('=') ? word.text.slice(word.text.indexOf('=') + 1) : word.text
        if (!value || value.startsWith('-')) continue
        const target = resolve(workingDirectory, value)
        if ((isAbsolute(value) || value.startsWith('..')) && !isWithin(realpathSync(exec.agent!.session.header.cwd!), target)) return 'Explicit paths outside the workspace require confirmation.'
        try {
          const info = lstatSync(target)
          if (info.isSymbolicLink() || realpathSync(target) !== target || (info.isFile() && info.nlink !== 1)) return 'Shell reads or writes through file aliases require confirmation.'
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') return 'Shell target identity cannot be verified.'
          try { if (realpathSync(dirname(target)) !== dirname(target)) return 'Shell target parent is a filesystem alias.' }
          catch { return 'Shell target parent cannot be verified.' }
        }
      }
    }
    if (/(?:\.env\b|\.ssh\b|\.dsh\b|\.codex\b|\.aws\b|Keychain|Login Data|Cookies|credentials|printenv|\benv\s*$|\bsecurity\s)/i.test(command)) return 'Credential or control-plane access requires human confirmation.'
    if (/\b(?:rm|rmdir|unlink|Remove-Item|del|erase|shred|chmod|chown|launchctl|crontab)\b|\bgit\s+(?:push|reset|clean)\b|\b(?:curl|wget)\b[^\n]*(?:--data|--upload|\s-[dTFX]\b)|\b(?:npm|pnpm)\s+publish\b/i.test(command)) return 'Deletion, access changes or external writes require human confirmation.'
    return undefined
  }
  // A public URL is sufficient for a navigation review; opaque clicks/evaluation
  // and third-party MCP implementations need richer verified effect evidence.
  if (['browser', 'web_fetch'].includes(exec.name)) {
    const action = args.action
    const keys = exec.name === 'web_fetch' ? ['url'] : ['action', 'url']
    if (Object.keys(args).some(k => !keys.includes(k)) || (exec.name === 'browser' && action !== 'navigate')) return 'Opaque browser effects require human confirmation.'
    try {
      const url = new URL(String(args.url))
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return 'Only complete public HTTPS navigation is eligible for model review.'
      if (isIP(url.hostname) || url.hostname.startsWith('[') || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname)) return 'Private-network or literal-address navigation requires confirmation.'
      return undefined
    } catch { return 'A valid public navigation URL is required.' }
  }
  return 'This tool requires human confirmation until its effects have a verified adapter.'
}
