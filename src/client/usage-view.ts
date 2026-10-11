import { createElement as h, type CSSProperties, type ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PluginDetailProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SAFE_REVIEW_PACKAGE, type UsageTier } from '../usage-contract.js'
import type { UsageClientState } from './usage-state.js'
import { moneyText, tierLabel, timeText, tokenText, type UsageTranslate } from './presentation.js'

export interface UsageFace {
  hooks: { usage: SnapshotStore<UsageClientState> }
  refresh(): void
  dismissNotice(): void
  openUsage(): void
}
export type UsageInjectedProps = InjectFace<UsageFace> & PropsLocale<'safeReviewUsage'>

const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #737780)', fontSize: 12, lineHeight: 1.6 }
const card: CSSProperties = { border: '1px solid var(--dsw-alias-border-l3, #dfe3e8)', borderRadius: 14, padding: 16, minWidth: 0 }
const heading: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600 }
const button: CSSProperties = { border: '1px solid var(--dsw-alias-border-l3, #dfe3e8)', borderRadius: 8,
  padding: '6px 12px', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' }

function stat(label: string, value: string, emphasis = false): ReactNode {
  return h('div', { key: label, style: { display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 10 } },
    h('dt', { style: muted }, label),
    h('dd', { style: { margin: 0, fontSize: emphasis ? 20 : 13, fontWeight: emphasis ? 600 : 400, fontVariantNumeric: 'tabular-nums' } }, value))
}

function TierCard({ tier, active, t }: { tier: UsageTier; active: boolean; t: UsageTranslate }): ReactNode {
  const quota = tier.allowance
  return h('article', { style: { ...card, borderColor: active ? '#5684d5' : card.borderColor }, 'data-tier': tier.id },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h('h3', { style: { ...heading, fontSize: 13 } }, tierLabel(tier.id, t)),
      active ? h('span', { style: { color: '#5684d5', fontSize: 11, fontWeight: 600 } }, t('active')) : null),
    h('p', { style: { fontWeight: 600, margin: '12px 0 16px', overflowWrap: 'anywhere' } }, tier.model),
    h('dl', { style: { margin: 0 } },
      quota === null ? h('div', { style: muted }, t('noFreeQuota')) : [
        stat(t(quota.source === 'local-estimate' ? 'estimatedRemaining' : 'remaining'), tokenText(quota.remainingTokens, t), true),
        stat(t('officialUsed'), tokenText(quota.officialUsedTokens ?? (quota.source === 'official' ? quota.usedTokens : null), t)),
        quota.source === 'official' ? null : stat(t('estimatedUsed'), tokenText(quota.usedTokens, t)),
        stat(t(quota.source === 'official' ? 'allowance' : 'configuredAllowance'), tokenText(quota.limitTokens, t)),
      ],
      stat(t('local'), tokenText(tier.localUsedTokens, t)), stat(t('cost'), moneyText(tier.estimatedCostUsd, t))),
    quota === null ? null : h('p', { style: { ...muted, margin: '14px 0 0' } },
      t(quota.source === 'official' ? 'official' : quota.source === 'local-estimate' ? 'estimate' : 'unknownSource'),
      h('br'), `${t('quotaUpdated')}: ${timeText(quota.updatedAt, t)}`,
      quota.officialUsageUpdatedAt == null ? null : [h('br', { key: 'official-break' }), `${t('officialUsageUpdated')}: ${timeText(quota.officialUsageUpdatedAt, t)}`]))
}

/** Pure view also used by render tests; UI hooks are bound only at the Slot boundary. */
export function UsageCard({ state, refresh, t }: { state: UsageClientState; refresh(): void; t: UsageTranslate }): ReactNode {
  const snapshot = state.snapshot
  return h('section', { 'aria-label': t('title'), style: { color: 'var(--dsw-alias-label-primary, #20242c)', width: '100%' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 } },
      h('h2', { style: heading }, t('title')),
      h('button', { type: 'button', style: button, disabled: state.refreshing, onClick: refresh }, t(state.refreshing ? 'refreshing' : 'refresh'))),
    h('p', { style: muted }, t('description')),
    state.stale ? h('p', { role: 'status', style: { ...muted, color: '#ad7721' } },
      t(snapshot === null ? 'unavailable' : snapshot.status === 'unavailable' ? 'quotaUnavailable' : 'stale')) : null,
    snapshot?.lastSwitch?.reason === 'paid-budget-exhausted'
      ? h('p', { role: 'status', style: { ...muted, padding: 12, borderRadius: 8, background: '#ad772114', color: '#ad7721' } }, t('paidBudgetNotice')) : null,
    snapshot === null ? (state.stale ? null : h('p', { role: 'status', style: muted }, t('loading')))
      : snapshot.status === 'disabled' ? h('p', { style: muted }, t('disabled')) : [
        h('div', { key: 'tiers', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginTop: 18 } },
          ...snapshot.tiers.map(tier => h(TierCard, { key: tier.id, tier, active: snapshot.activeTier === tier.id, t }))),
        h('div', { key: 'billing', style: { ...card, marginTop: 16 } },
          h('h3', { style: heading }, t('billing')),
          h('dl', { style: { margin: 0 } },
            stat(t('paidCap'), moneyText(snapshot.paidBudget?.limitUsd ?? null, t)),
            stat(t('paidUsed'), moneyText(snapshot.paidBudget?.estimatedUsedUsd ?? null, t)),
            stat(t('paidRemaining'), moneyText(snapshot.paidBudget?.remainingUsd ?? null, t)),
            stat(t('accountToday'), moneyText(snapshot.accountCosts?.todayUsd ?? null, t)),
            stat(t('accountMonth'), moneyText(snapshot.accountCosts?.monthUsd ?? null, t)),
            stat(t('accountCredit'), moneyText(snapshot.accountCredit.balanceUsd, t))),
          snapshot.accountCosts ? h('p', { style: muted }, `${t('costSource')} · ${timeText(snapshot.accountCosts.updatedAt, t)}`) : null,
          h('p', { style: muted }, t(snapshot.accountCredit.source === 'unknown' ? 'creditUnknown' : 'creditManual')),
          h('a', { href: 'https://platform.openai.com/settings/organization/billing/overview', target: '_blank', rel: 'noopener noreferrer',
            style: { fontSize: 12, color: '#5684d5' } }, t('billingLink'))),
        h('p', { key: 'notes', style: muted }, t('localNote'), h('br'), t('budgetNote')),
        h('p', { key: 'time', style: muted }, `${t('updated')}: ${timeText(state.refreshedAt, t)}`,
          h('br'), `${t('reset')}: ${timeText(snapshot.resetsAt, t)}`),
      ])
}

export function UsagePanel({ subject, useUsage, refresh, t }: UsageInjectedProps & PluginDetailProps): ReactNode {
  const state = useUsage(current => current)
  if (subject.kind !== 'bundle' || subject.pkg.name !== SAFE_REVIEW_PACKAGE) return null
  return h(UsageCard, { state, refresh, t })
}
