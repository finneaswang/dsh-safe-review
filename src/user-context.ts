import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'

export interface UserContextSnapshot {
  readonly version: string
  readonly messages: readonly { readonly seq: number; readonly text: string }[]
  readonly complete: boolean
  readonly reason?: string
}

/** Includes JSON framing/sequence metadata, not only characters of user text. */
export const USER_CONTEXT_MAX_BYTES = 32 * 1024
export const USER_CONTEXT_PROJECTION_KEY = 'finneasSafeReviewUserContextV2' as const
const MAX_PENDING_ITEMS = 512
const MAX_ID_BYTES = 512
const OVERFLOW = 'Verified human instruction history exceeds the 32 KiB review limit.'
const NON_TEXT = 'A verified human instruction contains non-text or incomplete content.'
const QUEUE_INVALID = 'Pending human instruction history could not be reconstructed completely.'
const SUBAGENT = 'A subagent cannot establish human authorization from its delegated prompt.'

const messageSchema = z.object({ seq: z.number().int().nonnegative(), text: z.string() }).strict()
const queueIdSchema = z.string().min(1).refine(id => Buffer.byteLength(id, 'utf8') <= MAX_ID_BYTES)
const queueItemSchema = z.object({ id: queueIdSchema, human: z.boolean() }).strict()
const queueSchema = z.array(queueItemSchema).max(MAX_PENDING_ITEMS)
const stateSchema = z.object({
  sessionId: z.string(),
  version: z.string(),
  messages: z.array(messageSchema),
  invalidReason: z.string().nullable(),
  inbox: z.object({ 'next-turn': queueSchema, 'next-step': queueSchema }).strict(),
  // A claim is recorded before agent/pre-step can await or rewrite the input.
  // Keep it unresolved until the matching human message enters the surface.
  claimed: z.array(queueIdSchema).max(MAX_PENDING_ITEMS),
}).strict().refine(state => Buffer.byteLength(JSON.stringify(state.messages), 'utf8') <= USER_CONTEXT_MAX_BYTES
  && state.messages.every((message, index) => index === 0 || message.seq > state.messages[index - 1]!.seq)
  && state.inbox['next-turn'].length + state.inbox['next-step'].length <= MAX_PENDING_ITEMS)

type UserContextState = z.infer<typeof stateSchema>
type QueueItem = z.infer<typeof queueItemSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    finneasSafeReviewUserContextV2: UserContextState
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Match the official Desktop RPC provenance, never a user-role label alone. */
function isHuman(message: unknown): message is Record<string, unknown> {
  if (!record(message) || !record(message.source)) return false
  return message.source.kind === 'user'
    && typeof message.source.rpcId === 'string' && message.source.rpcId.trim().length > 0
}

function init(header: SessionHeader): UserContextState {
  return {
    sessionId: header.id,
    version: `${header.id}:initial`,
    messages: [],
    invalidReason: header.origin === 'subagent' ? SUBAGENT : null,
    inbox: { 'next-turn': [], 'next-step': [] },
    claimed: [],
  }
}

function invalid(state: UserContextState, version: string, reason: string): UserContextState {
  return { ...state, version, invalidReason: state.invalidReason ?? reason }
}

function foldInbox(state: UserContextState, event: SessionEvent): UserContextState {
  const version = `${state.sessionId}:${event.seq}`
  // Once queue tracking itself is lost it cannot be repaired by a later splice.
  if (state.invalidReason === QUEUE_INVALID) return { ...state, version }
  const data: unknown = event.data
  if (!record(data) || (data.target !== 'next-turn' && data.target !== 'next-step')
    || !Number.isSafeInteger(data.start) || !Array.isArray(data.inserted)) return invalid(state, version, QUEUE_INVALID)
  const target = data.target
  const start = data.start as number
  const removedCount = data.removedCount ?? 0
  const previous = state.inbox[target]
  if (!Number.isSafeInteger(removedCount) || (removedCount as number) < 0 || start < 0
    || start + (removedCount as number) > previous.length || start > previous.length
    || data.inserted.length > MAX_PENDING_ITEMS
    || (data.outcome !== undefined && data.outcome !== 'canceled')) return invalid(state, version, QUEUE_INVALID)
  const inserted: QueueItem[] = []
  for (const message of data.inserted) {
    if (!record(message) || typeof message.id !== 'string' || !message.id
      || Buffer.byteLength(message.id, 'utf8') > MAX_ID_BYTES) return invalid(state, version, QUEUE_INVALID)
    inserted.push({ id: message.id, human: isHuman(message) })
  }
  const removed = previous.slice(start, start + (removedCount as number))
  const next = [...previous.slice(0, start), ...inserted, ...previous.slice(start + (removedCount as number))]
  const inbox = { ...state.inbox, [target]: next }
  const all = [...inbox['next-turn'], ...inbox['next-step']]
  if (all.length > MAX_PENDING_ITEMS || new Set(all.map(item => item.id)).size !== all.length) return invalid(state, version, QUEUE_INVALID)
  const claimed = data.outcome === 'canceled'
    ? state.claimed
    : [...state.claimed, ...removed.filter(item => item.human).map(item => item.id)]
  if (claimed.length > MAX_PENDING_ITEMS || new Set(claimed).size !== claimed.length) return invalid(state, version, QUEUE_INVALID)
  return { ...state, version, inbox, claimed }
}

function fold(state: UserContextState, event: SessionEvent): UserContextState {
  if (event.type === 'agent/inbox/spliced') return foldInbox(state, event)
  const version = `${state.sessionId}:${event.seq}`
  if (['approval/policy', 'sandbox/mode', 'permission/preset', 'agent-preset/selected', 'model/selection'].includes(event.type)) {
    return { ...state, version }
  }
  if (event.type !== 'user/message' || !isHuman(event.data)) return state
  const data = event.data
  const next = { ...state, version, claimed: state.claimed.filter(id => id !== data.id) }
  if (!Array.isArray(data.content) || data.content.length === 0) return invalid(next, version, NON_TEXT)
  let text = ''
  let nonText = false
  for (const block of data.content) {
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') { nonText = true; continue }
    // No partial instruction is retained: exceeding the cap invalidates the
    // entire review context while preserving every earlier complete message.
    if (Buffer.byteLength(text, 'utf8') + Buffer.byteLength(block.text, 'utf8') > USER_CONTEXT_MAX_BYTES) return invalid(next, version, OVERFLOW)
    text += (text ? '\n' : '') + block.text
  }
  if (nonText || !text.trim()) next.invalidReason ??= NON_TEXT
  if (!text) return next
  const messages = [...next.messages, { seq: event.seq as number, text }]
  if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > USER_CONTEXT_MAX_BYTES) return invalid(next, version, OVERFLOW)
  return { ...next, messages }
}

/** Pure, JSON-only host fold; intentionally has no wire/client-view field. */
export const userContextProjection: ProjectionDefinition<typeof USER_CONTEXT_PROJECTION_KEY> = {
  key: USER_CONTEXT_PROJECTION_KEY,
  stateSchema,
  stateVersion: 1,
  init,
  apply: fold,
}

function snapshot(state: UserContextState): UserContextSnapshot {
  const reason = state.invalidReason
    ?? (state.claimed.length || [...state.inbox['next-turn'], ...state.inbox['next-step']].some(item => item.human)
      ? 'New human input is queued or has not yet entered the current step.'
      : state.messages.length === 0 ? 'No verified Desktop human instruction is available.' : undefined)
  return Object.freeze({
    version: state.version,
    messages: Object.freeze(state.messages.map(message => Object.freeze({ ...message }))),
    complete: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
  })
}

function unavailable(session: Session): UserContextSnapshot {
  return Object.freeze({
    version: `${session.id}:unavailable`,
    messages: Object.freeze([]),
    complete: false,
    reason: 'The official session projection service is unavailable for human context verification.',
  })
}

/** Register using the plugin fiber and read a synchronous, detached evidence cut. */
export function mountUserContext(ctx: Context): (session: Session) => UserContextSnapshot {
  let readCurrent: ((session: Session) => UserContextSnapshot) | undefined
  try {
    // The gate need not require this optional capability to keep basic rules
    // and human approval working. Cordis also requires service access from an
    // injected scope, even when the same service is present on the root.
    ctx.inject(['sessionProjections'], injected => {
      try {
        injected.sessionProjections.register(userContextProjection)
        const reader = (session: Session): UserContextSnapshot => {
          try {
            // Scoped service proxy identity is not stable across reads.
            const state = injected.sessionProjections.stateOf(session, USER_CONTEXT_PROJECTION_KEY)
            return state ? snapshot(state) : unavailable(session)
          } catch { return unavailable(session) }
        }
        readCurrent = reader
        injected.effect(() => () => { if (readCurrent === reader) readCurrent = undefined })
      } catch { readCurrent = undefined }
    })
  } catch { /* No optional capability means human confirmation. */ }
  return session => readCurrent ? readCurrent(session) : unavailable(session)
}
