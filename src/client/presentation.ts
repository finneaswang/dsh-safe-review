import type { UsageSwitch, UsageTierId } from '../usage-contract.js'
import type { UsageLocaleKey } from './locales.js'

export type UsageTranslate = (key: UsageLocaleKey, params?: Record<string, string>) => string
export function tierLabel(id: UsageTierId, t: UsageTranslate): string {
  return t(id === 'free-primary' ? 'primary' : id === 'free-secondary' ? 'secondary' : 'paid')
}
export function tokenText(value: number | null, t: UsageTranslate): string {
  return value === null ? t('unknown') : new Intl.NumberFormat(t('language')).format(value)
}
export function moneyText(value: number | null, t: UsageTranslate): string {
  return value === null ? t('unknown') : new Intl.NumberFormat(t('language'), {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 8,
  }).format(value)
}
export function timeText(value: number | null, t: UsageTranslate): string {
  return value === null ? t('unknown') : new Intl.DateTimeFormat(t('language'), {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(value)
}
export function switchText(change: UsageSwitch, model: string, t: UsageTranslate): string {
  if (change.reason === 'paid-budget-exhausted') return t('paidBudgetExhausted')
  if (change.reason === 'service-unavailable' && change.from === change.to) return t('servicePaused')
  const reason: Record<Exclude<UsageSwitch['reason'], 'paid-budget-exhausted'>, UsageLocaleKey> = {
    'free-exhausted': 'exhausted', 'daily-reset': 'resetReason', configured: 'configured', 'service-unavailable': 'serviceUnavailable',
  }
  return t('switched', { model, tier: tierLabel(change.to, t), reason: t(reason[change.reason]) })
}
