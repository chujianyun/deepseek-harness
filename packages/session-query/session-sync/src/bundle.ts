/**
 * What one upload carries: which stored Sessions belong to a top-level Session's bundle, the
 * attachments its events reference, and the facts its upload names (bound assistant, last change).
 */
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { assistantProjectionDefinition, type AssistantProjectionState } from '@deepseek-ai/dsh-assistants'
import type { ImageAttachmentRef, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSyncAssistant, SessionSyncBundle, SessionSyncLog } from './types.ts'

const ATTACHMENT_ID = /^sha256:([0-9a-f]{64})$/u

/** One attachment the bundle's events reference. */
export type BundleAttachment =
  | { readonly kind: 'image'; readonly sha256: string; readonly ref: ImageAttachmentRef }
  | { readonly kind: 'file'; readonly sha256: string; readonly ref: FileAttachmentRef }

/**
 * The top-level Session a stored Session belongs to: itself unless it is a subagent Session, whose
 * parent chain is followed. A subagent Session whose parent is unknown has none.
 * @param id - a stored Session.
 * @param headers - headers of every stored Session, by id.
 * @returns the top-level Session's id, or undefined.
 */
export function rootOf(id: SessionId, headers: ReadonlyMap<SessionId, SessionHeader>): SessionId | undefined {
  const seen = new Set<SessionId>()
  let current = headers.get(id)
  while (current?.origin === 'subagent') {
    if (seen.has(current.id) || current.parentSession === undefined) return undefined
    seen.add(current.id)
    current = headers.get(current.parentSession)
  }
  return current?.id
}

/**
 * The bundles of every top-level Session: each with its subagent Sessions (and theirs), ordered by
 * id, newest top-level Session first. Subagent Sessions without a top-level Session belong to none.
 * @param items - every stored Session, with its header.
 * @returns each bundle's members, the top-level Session first.
 */
export function bundleGroups<T extends { readonly header: SessionHeader }>(items: readonly T[]): [T, ...T[]][] {
  const headers = new Map(items.map(item => [item.header.id, item.header]))
  const below = new Map<SessionId, T[]>()
  for (const item of items) {
    if (item.header.origin !== 'subagent') continue
    const root = rootOf(item.header.id, headers)
    if (root !== undefined) below.set(root, [...below.get(root) ?? [], item])
  }
  return items
    .filter(item => item.header.origin !== 'subagent')
    .sort((a, b) => b.header.createdAt - a.header.createdAt)
    .map(root => [root, ...(below.get(root.header.id) ?? []).sort((a, b) => a.header.id.localeCompare(b.header.id))])
}

/**
 * Every attachment the bundle's events reference, once per content digest. Images are references
 * with a media type; other references name a verbatim file.
 * @param bundle - the bundle.
 * @returns the attachments, in first-reference order.
 */
export function bundleAttachments(bundle: SessionSyncBundle): BundleAttachment[] {
  const found = new Map<string, BundleAttachment>()
  const pending: unknown[] = bundle.sessions.map(log => log.events).reverse()
  while (pending.length > 0) {
    const value = pending.pop()
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push(value[index])
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    const sha256 = typeof record.attachmentId === 'string' ? ATTACHMENT_ID.exec(record.attachmentId)?.[1] : undefined
    if (sha256 !== undefined) {
      // A validated Session event holds `sha256:` attachment ids only in the store's own references.
      if (!found.has(sha256)) {
        found.set(sha256, typeof record.mediaType === 'string'
          ? { kind: 'image', sha256, ref: record as never }
          : { kind: 'file', sha256, ref: record as never })
      }
      continue
    }
    pending.push(...Object.values(record).reverse())
  }
  return [...found.values()]
}

/**
 * The assistant a Session is bound to, read from its log: the last `assistant/selected` event, whose
 * empty id records going back to none.
 * @param events - the Session's log.
 * @returns the assistant's id, or null.
 */
export function boundAssistant(events: readonly SessionEvent[]): string | null {
  let state: AssistantProjectionState = assistantProjectionDefinition.init()
  for (const event of events) state = assistantProjectionDefinition.apply(state, event)
  return state.assistantId
}

/**
 * When the bundle last changed: its latest event time, or the top-level Session's creation.
 * @param bundle - the bundle.
 * @returns epoch milliseconds.
 */
export function lastChange(bundle: SessionSyncBundle): number {
  let latest = bundle.sessions[0].header.createdAt
  for (const log of bundle.sessions) for (const event of log.events) latest = Math.max(latest, event.time)
  return latest
}

/**
 * The ids of the assistants a bundle's events select.
 * @param bundle - the bundle.
 * @returns the ids, once each.
 */
export function selectedAssistants(bundle: SessionSyncBundle): string[] {
  const ids = new Set<string>()
  for (const log of bundle.sessions) {
    for (const event of log.events) if (event.type === 'assistant/selected' && event.data.assistantId !== '') ids.add(event.data.assistantId)
  }
  return [...ids]
}

/**
 * Point a pulled bundle's assistant selections at this computer's matching assistants: the one with
 * the same template, or else the one with the same name, when exactly one matches. A selection with
 * no match keeps the other computer's id, which this computer shows as an unknown assistant.
 * @param bundle - the pulled bundle.
 * @param local - this computer's assistants of the tenant.
 * @returns the bundle with its selections mapped.
 */
export function mapAssistants(bundle: SessionSyncBundle, local: readonly SessionSyncAssistant[]): SessionSyncBundle {
  const mapped = new Map<string, string>()
  for (const remote of bundle.assistants ?? []) {
    const byTemplate = remote.templateId === null ? [] : local.filter(item => item.templateId === remote.templateId)
    const [only, another] = byTemplate.length > 0 ? byTemplate : local.filter(item => item.name === remote.name)
    if (only !== undefined && another === undefined) mapped.set(remote.id, only.id)
  }
  if (mapped.size === 0) return bundle
  const mapLog = (log: SessionSyncLog): SessionSyncLog => ({
    ...log,
    events: log.events.map((event) => {
      if (event.type !== 'assistant/selected') return event
      const target = mapped.get(event.data.assistantId)
      return target === undefined ? event : { ...event, data: { ...event.data, assistantId: target } }
    }),
  })
  const [head, ...below] = bundle.sessions
  return { ...bundle, sessions: [mapLog(head), ...below.map(mapLog)] }
}

const compress = promisify(gzip)

/**
 * The bundle as uploaded: gzip-compressed JSON, compressed off the event loop, and the sha256 of
 * that JSON, which names its content.
 * @param bundle - the bundle.
 * @returns the compressed bytes and the content digest.
 */
export async function encodeBundle(bundle: SessionSyncBundle): Promise<{ readonly bytes: Uint8Array; readonly digest: string }> {
  const json = JSON.stringify(bundle)
  return { bytes: await compress(json), digest: createHash('sha256').update(json).digest('hex') }
}
