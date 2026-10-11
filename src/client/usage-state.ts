/** Polling and notification state independent of React and the Host budget implementation. */
import { publicUsageSnapshot, type UsageSnapshot, type UsageSwitch } from '../usage-contract.js'

export interface UsageClientState {
  readonly snapshot: UsageSnapshot | null
  readonly refreshing: boolean
  readonly stale: boolean
  readonly refreshedAt: number | null
  readonly notice: UsageSwitch | null
}
export interface UsageStateStore {
  getSnapshot(): UsageClientState
  set(state: UsageClientState): void
}
export const initialUsageClientState: UsageClientState = {
  snapshot: null, refreshing: false, stale: false, refreshedAt: null, notice: null,
}

/** A single in-flight request prevents slow earlier snapshots replacing newer ones. */
export class UsageController {
  private stopped = false
  private started = false
  private request: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private baselineSeen = false
  private lastSwitchKey: string | null = null

  constructor(private readonly store: UsageStateStore,
    private readonly read: () => Promise<unknown>,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 5000) {}

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    void this.tick()
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.request) return this.request
    this.store.set({ ...this.store.getSnapshot(), refreshing: true })
    this.request = this.pull().finally(() => { this.request = undefined })
    return this.request
  }

  dismissNotice(): void {
    this.store.set({ ...this.store.getSnapshot(), notice: null })
  }

  dispose(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
  }

  private async tick(): Promise<void> {
    await this.refresh()
    if (!this.stopped) this.timer = setTimeout(() => { void this.tick() }, this.intervalMs)
  }

  private async pull(): Promise<void> {
    try {
      const snapshot = publicUsageSnapshot(await this.read())
      if (this.stopped) return
      const previous = this.store.getSnapshot()
      if (snapshot.status === 'unavailable' && snapshot.tiers.length !== 3) {
        this.store.set({ ...previous, refreshing: false, stale: true })
        return
      }
      const change = snapshot.lastSwitch
      const key = change === null ? null : `${change.at}:${change.sequence}:${change.to}:${change.reason}`
      // The opening snapshot is state restoration, never a new notification.
      const notice = this.baselineSeen && key !== null && key !== this.lastSwitchKey
        ? change : previous.notice
      this.baselineSeen = true
      this.lastSwitchKey = key
      this.store.set({ snapshot, refreshing: false, stale: snapshot.status === 'unavailable',
        refreshedAt: this.now(), notice })
    } catch {
      if (!this.stopped) this.store.set({ ...this.store.getSnapshot(), refreshing: false, stale: true })
    }
  }
}
