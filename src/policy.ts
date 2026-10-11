/** Conservative policy layered over NanmiCoder's audited path/shell fuses. */
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { hardDenyReason } from './vendor/policy.js'
import { isWithin, normalizePath, resolveRoots } from './vendor/paths.js'
import { decomposeCommandLine, type ShellKind } from './vendor/shell.js'
import { isDirectoryListing } from './directory-listing.js'

export type Risk = 'low' | 'sensitive' | 'high' | 'unknown'
export interface Assessment { risk: Risk; reason: string }
export interface PolicyOptions { protectedRoots: readonly string[] }
const PROTECTED = /(?:^|[/\\])(?:\.dsh|\.codex|\.ssh|\.gnupg|\.aws|\.kube|\.git|\.agents|\.vscode|\.husky|node_modules)(?:[/\\]|$)|(?:^|[/\\])(?:cordis[^/\\]*\.(?:ya?ml|json)|AGENTS\.md|CLAUDE\.md|\.mcp\.json|\.npmrc|\.zshrc|\.bashrc|\.profile)$/i
const SECRET = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|credentials(?:\.[^/\\]*)?|id_rsa|id_ed25519|Cookies|Login Data|Keychains)(?:[/\\]|$)/i
const PRIVILEGED_TOOL = /(?:^|[_.:/-])(?:cordis|plugin_manager|plugin_(?:install|enable|disable|remove|update)|permissions?|shell_env|sandbox)(?:$|[_.:/-])/i
const SECRET_TEXT = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function result(risk: Risk, reason: string): Assessment { return { risk, reason } }

/** Resolve existing ancestors as well as new children of a protected directory. */
function resolvedCandidate(path: string): string {
  const suffix: string[] = []
  let cursor = path
  while (cursor !== dirname(cursor)) {
    try { return resolve(realpathSync(cursor), ...suffix) } catch { suffix.unshift(basename(cursor)); cursor = dirname(cursor) }
  }
  return path
}

function protectedShellTarget(value: string, cwd: string, options: PolicyOptions, includeAncestors: boolean): boolean {
  const valuePath = /^(?:--?[\w-]+|[A-Za-z_]\w*)=/.test(value) ? value.slice(value.indexOf('=') + 1) : value
  if (!valuePath || valuePath.startsWith('-')) return false
  const path = normalizePath(valuePath, cwd)
  const actual = resolvedCandidate(path)
  if (PROTECTED.test(path) || PROTECTED.test(actual) || SECRET.test(path) || SECRET.test(actual)) return true
  return options.protectedRoots.some(root => [resolve(root), resolvedCandidate(resolve(root))].some(protectedRoot =>
    isWithin(protectedRoot, path) || isWithin(protectedRoot, actual)
    || (includeAncestors && (isWithin(path, protectedRoot) || isWithin(actual, protectedRoot)))))
}

/** Explicit protected shell targets cannot be promoted by a model verdict. */
export function protectedShellAssessment(command: string, cwd: string, shell: ShellKind, options: PolicyOptions): Assessment | undefined {
  const parsed = decomposeCommandLine(command, shell)
  if (parsed.kind === 'opaque') return undefined // The eligibility floor handles incomplete syntax.
  for (const segment of parsed.segments) {
    if (segment.writeTargets.some(word => !word.dynamic && protectedShellTarget(word.text, cwd, options, true))) {
      return result('high', 'Shell redirection could mutate protected configuration or credentials.')
    }
    const name = basename(segment.words[0]?.text ?? '').toLowerCase()
    const mutation = /^(?:rm|rmdir|unlink|shred|mv|cp|install|tee|touch|mkdir|chmod|chown|chgrp|truncate|dd|sed|perl|python\d*(?:\.\d+)?|node|ruby|remove-item|set-content|add-content|copy-item|move-item|new-item|clear-content)$/.test(name)
      || (name === 'find' && segment.words.some(word => /^-(?:delete|fprint|fprint0|fprintf|fls)$/.test(word.text)))
    if (mutation && options.protectedRoots.some(root => [resolve(root), resolvedCandidate(resolve(root))].some(path =>
      segment.words.some(word => word.text.includes(path))))) {
      return result('high', 'A shell mutation explicitly names protected configuration or credentials.')
    }
    const words = [...segment.words.slice(1), ...segment.readTargets]
    if (words.some(word => !word.dynamic && protectedShellTarget(word.text, cwd, options, mutation))) {
      return result(mutation ? 'high' : 'sensitive', mutation ? 'Possible shell mutation of protected configuration or credentials.' : 'Shell access to protected configuration or credentials requires confirmation.')
    }
    // Recursive readers can traverse a protected directory beneath an ordinary
    // parent even if its pathname is not explicitly written in the command.
    if (['rg', 'grep', 'find', 'tar', 'zip', 'cp', 'ls', 'du'].includes(name)) {
      const targets = words.filter(word => !word.text.startsWith('-'))
      if ((!targets.length && protectedShellTarget(cwd, cwd, options, true))
        || targets.some(word => !word.dynamic && protectedShellTarget(word.text, cwd, options, true))) {
        return result(mutation ? 'high' : 'sensitive', 'A recursive shell target contains protected configuration or credentials.')
      }
      // rg/grep may use only a search pattern and implicitly traverse cwd.
      if (['rg', 'grep'].includes(name) && targets.length <= 1 && protectedShellTarget(cwd, cwd, options, true)) {
        return result('sensitive', 'Implicit workspace search may include protected configuration or credentials.')
      }
    }
  }
  return undefined
}

/** Resolve existing ancestors; links, missing parents and non-files require review. */
function localPath(path: string, cwd: string, write: boolean, options: PolicyOptions): Assessment {
  const target = resolve(cwd, path)
  if (PROTECTED.test(target) || options.protectedRoots.some(root => isWithin(root, target))) {
    return result(write ? 'high' : 'sensitive', 'Protected configuration or plugin installation path.')
  }
  if (SECRET.test(target)) return result('sensitive', 'Potential credential or private account data.')
  try {
    const actual = realpathSync(target)
    if (PROTECTED.test(actual) || options.protectedRoots.some(root => isWithin(root, actual))) return result(write ? 'high' : 'sensitive', 'Resolved target is protected configuration.')
    if (SECRET.test(actual)) return result('sensitive', 'Resolved target contains private account data.')
  } catch { /* A new ordinary file is checked via its parent below. */ }
  let root: string
  try { root = realpathSync(cwd) } catch { return result('unknown', 'Workspace cannot be resolved.') }
  if (!isWithin(root, target)) return result('sensitive', 'Target is outside the workspace.')
  try {
    let cursor = target
    while (cursor !== dirname(cursor)) {
      try {
        const stat = lstatSync(cursor)
        if (stat.isSymbolicLink()) return result(write ? 'high' : 'unknown', 'Writes through symbolic links are blocked; reads require exact human review.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (cursor !== target) return result('unknown', 'Parent directory does not exist.')
      }
      cursor = dirname(cursor)
    }
    if (!isWithin(root, realpathSync(dirname(target)))) return result('sensitive', 'Resolved parent escapes the workspace.')
    try {
      const stat = lstatSync(target)
      if (stat.nlink > 1 && write) return result('high', 'Writes through shared hard links are blocked.')
      if (!stat.isFile() || stat.nlink !== 1) return result('unknown', 'Only ordinary files with one hard link qualify.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !write) throw error
    }
  } catch { return result('unknown', 'Target identity cannot be verified.') }
  return result('low', write ? 'Ordinary workspace file update.' : 'Ordinary workspace file read.')
}

/** Classify complete arguments. Unrecognized tools and parameters never auto-allow. */
export function assess(exec: Readonly<ToolExecution>, options: PolicyOptions): Assessment {
  const cwd = exec.agent?.session.header.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return result('unknown', 'A verified workspace is required.')
  const roots = resolveRoots(cwd)
  const hard = hardDenyReason(exec, roots)
  if (hard) return result('high', hard)
  const args = object(exec.arguments)
  if (!args) return result('unknown', 'Arguments must be a JSON object.')
  const serialized = JSON.stringify(args)
  if (serialized.length > 100_000) return result('unknown', 'Action exceeds the complete-review size limit.')
  if (PRIVILEGED_TOOL.test(exec.name)) return result('high', 'Agent modification of plugins or standing permissions is blocked.')
  if (['read', 'write', 'edit'].includes(exec.name) && typeof args.file_path === 'string') {
    const pathRisk = localPath(args.file_path, cwd, exec.name !== 'read', options)
    if (pathRisk.risk === 'high') return pathRisk
  }
  if ('sandbox_permissions' in args && args.sandbox_permissions !== undefined) {
    return result('sensitive', 'One-shot sandbox widening requires native human confirmation.')
  }
  if (SECRET_TEXT.test(serialized)) return result(['read', 'write', 'edit'].includes(exec.name) ? 'sensitive' : 'high', 'Potential secret material in an external or opaque action is blocked.')
  if (exec.name === 'bash' || exec.name === 'pwsh') {
    if (typeof args.command !== 'string') return result('unknown', 'Terminal input is incomplete or refers to a persistent process.')
    if (isDirectoryListing(exec)) return result('low', 'Static non-recursive directory listing: names and metadata only; no file contents or changes.')
    const protectedShell = protectedShellAssessment(args.command, resolve(cwd, typeof args.workdir === 'string' ? args.workdir : '.'), exec.name, options)
    if (protectedShell) return protectedShell
    if (PROTECTED.test(args.command) && /\b(?:rm|mv|cp|tee|chmod|chown|sed|perl|python|node)\b|[>]/.test(args.command)) {
      return result('high', 'Possible mutation of protected configuration.')
    }
    return result('unknown', 'Shell programs and persistent terminal state require human review.')
  }
  const specifications: Record<string, { keys: string[]; write: boolean }> = {
    read: { keys: ['file_path', 'offset', 'limit'], write: false },
    write: { keys: ['file_path', 'content'], write: true },
    edit: { keys: ['file_path', 'old_string', 'new_string', 'replace_all'], write: true },
  }
  const spec = specifications[exec.name]
  if (spec) {
    if (Object.keys(args).some(key => !spec.keys.includes(key)) || typeof args.file_path !== 'string') return result('unknown', 'Unrecognized filesystem parameters.')
    return localPath(args.file_path, cwd, spec.write, options)
  }
  // Browser, Computer Use, MCP and opaque PTC containers all reach native confirmation.
  // Tool names and MCP readOnlyHint alone are not evidence of their effects.
  return result('unknown', 'This tool has no verified low-risk adapter; review the exact action.')
}
