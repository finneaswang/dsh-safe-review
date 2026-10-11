/** Browser companion: safe accounting snapshots, existing Plugins detail card, global switch Toast. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SAFE_REVIEW_PACKAGE } from '../usage-contract.js'
import { usageRemoteContribution } from '../usage-descriptor.js'
import { UsageController, initialUsageClientState } from './usage-state.js'
import { UsagePanel, type UsageFace } from './usage-view.js'
import { UsageToast } from './usage-toast.js'
import { en, zh } from './locales.js'

export const name = 'finneas-safe-review-usage'
export const inject = ['slots', 'locale', 'remote', 'pluginNavigation']

export async function apply(ctx: Context): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(usageRemoteContribution)
  ctx.effect(() => disposeRemote, 'safe-review: usage Remote mount')
  ctx.effect(() => ctx.locale.register('safeReviewUsage', { en, zh }))
  // Mount creates a distinct Cordis service. Consume it from a dependent
  // scope; declaring it on this plugin would prevent its own mount from running.
  await ctx.inject(['remote.safeReviewUsage'], ctx => {
    const state = createSnapshotStore(initialUsageClientState)
    const controller = new UsageController(state, async () => {
      const result = await ctx.remote.safeReviewUsage.snapshot()
      if (!result.ok) throw new Error('Usage unavailable')
      return result.value
    })
    ctx.effect(() => { controller.start(); return () => { controller.dispose() } })
    ctx.on('connection/reset', () => { void controller.refresh() })
    const face = (): UsageFace => ({
      hooks: { usage: state }, refresh: () => { void controller.refresh() },
      dismissNotice: () => { controller.dismissNotice() },
      openUsage: () => { ctx.pluginNavigation.openBundle(SAFE_REVIEW_PACKAGE) },
    })
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'finneas-safe-review.switch-toast', locale: 'safeReviewUsage', inject: face,
    }, UsageToast))
    ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
      name: 'plugins.detail.section', id: 'finneas-safe-review.usage', order: 10, locale: 'safeReviewUsage', inject: face,
    }, UsagePanel))
  })
}
