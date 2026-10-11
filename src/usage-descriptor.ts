/** One explicitly declared, read-only method shared by both Gateway faces. */
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { SAFE_REVIEW_PACKAGE, usageSnapshotSchema, type UsageSnapshot } from './usage-contract.js'

export const usageSnapshotDescriptor: InvocationDescriptor = Object.freeze({
  id: `${SAFE_REVIEW_PACKAGE}#safeReviewUsage/snapshot`,
  service: 'safeReviewUsage', namespace: 'safeReviewUsage', method: 'snapshot',
  invocation: { kind: 'direct' as const }, parameters: [],
  result: { mode: 'strict' as const, typeSymbol: `${SAFE_REVIEW_PACKAGE}#UsageSnapshot`, create: () => usageSnapshotSchema },
  sourceLocation: { file: 'src/usage-remote.ts', line: 1, column: 1 },
})

export const usageRemoteContribution: TypertRemoteContribution = {
  package: SAFE_REVIEW_PACKAGE, descriptors: [usageSnapshotDescriptor],
}
export default usageRemoteContribution

export interface UsageRemote {
  snapshot(): Promise<RemoteResult<UsageSnapshot>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap { 'safeReviewUsage/snapshot': UsageRemote['snapshot'] }
  interface TypertRemoteNamespaceMap { safeReviewUsage: UsageRemote }
}
