/** Optional Host UI bridge. Its absence never changes approval decisions. */
import type { Context } from '@deepseek-ai/cordis'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { usageSnapshotDescriptor } from './usage-descriptor.js'
import { SAFE_REVIEW_PACKAGE, publicUsageSnapshot, unavailableUsageSnapshot, type UsageSnapshot } from './usage-contract.js'

export type UsageSnapshotProvider = () => unknown | Promise<unknown>

declare module '@deepseek-ai/cordis' {
  interface Context { safeReviewUsage: { snapshot(): Promise<UsageSnapshot> } }
}

/** No network or filesystem work is owned here; the caller supplies an accounting snapshot. */
export function mountUsageRemote(ctx: Context, snapshot: UsageSnapshotProvider): void {
  ctx.inject(['typert'], injected => {
    const service = {
      async snapshot(): Promise<UsageSnapshot> {
        try { return publicUsageSnapshot(await snapshot()) }
        catch { return unavailableUsageSnapshot() }
      },
    }
    injected.provide('safeReviewUsage', Object.assign(service, { typertRemote: bindTypertRemote(service, 'safeReviewUsage') }))
    injected.effect(() => injected.typert.register({
      package: SAFE_REVIEW_PACKAGE, face: 'host', schemas: [],
      invocations: [usageSnapshotDescriptor],
      model: { services: [], events: [], objects: [] },
    }), 'safe-review: read-only usage snapshot')
  })
}
