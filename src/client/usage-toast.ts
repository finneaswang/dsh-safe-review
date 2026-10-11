import { createElement as h, type ReactNode } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UsageInjectedProps } from './usage-view.js'
import { switchText } from './presentation.js'

export function UsageToast({ useUsage, dismissNotice, openUsage, t }: UsageInjectedProps): ReactNode {
  const state = useUsage(current => current)
  const change = state.notice
  if (change === null) return null
  const model = state.snapshot?.tiers.find(tier => tier.id === change.to)?.model ?? t('unknown')
  return h(Toast, { key: `${change.at}:${change.sequence}`, text: switchText(change, model, t), holdMs: 6000,
    actions: [{ label: t('viewUsage'), onClick: () => { dismissNotice(); openUsage() } }], onDone: dismissNotice })
}
