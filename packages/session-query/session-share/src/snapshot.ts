/**
 * The conversation snapshot a share carries: what the user typed and what the assistant answered,
 * with each reply's tool calls reduced to a name and a one-line summary. Reasoning, tool results,
 * attachment contents, and user-role messages the user did not type stay out.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionShareMessage, SessionShareToolCall } from './types.ts'

/** Longest summary of one tool call's arguments. */
const SUMMARY_MAX = 120

/** Shorten text to `max` code points, marking the cut. */
function clip(text: string, max: number): string {
  const points = Array.from(text)
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`
}

/**
 * One line naming a tool call's scalar arguments. Nested values are left out, and arguments that
 * are not a JSON object give no summary.
 */
function summaryOf(rawArguments: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    // The model's raw argument text was not JSON: the call is named without a summary.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const parts = Object.entries(parsed)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .map(([key, value]) => `${key}=${String(value).replaceAll(/\s+/gu, ' ')}`)
  return parts.length === 0 ? undefined : clip(parts.join(', '), SUMMARY_MAX)
}

/** The text a user message shows: its text parts, then one line naming each attachment. */
function userText(content: readonly ContentBlock[]): string {
  const lines: string[] = []
  for (const block of content) {
    if (block.type === 'text') lines.push(block.text)
    else if (block.type === 'file' || block.type === 'image') {
      const name = block.attachment.name
      lines.push(name === undefined ? '[附件]' : `[附件：${name}]`)
    }
  }
  return lines.join('\n').trim()
}

/**
 * Build the snapshot from a Session's own events.
 * @param events - the Session's log in order.
 * @returns the messages to share; empty when the log holds no conversation.
 */
export function buildShareSnapshot(events: readonly SessionEvent[]): SessionShareMessage[] {
  const messages: SessionShareMessage[] = []
  /** The reply being assembled from consecutive assistant steps. */
  let reply: { texts: string[]; tools: SessionShareToolCall[]; at: string } | undefined
  const flush = (): void => {
    if (reply === undefined) return
    const text = reply.texts.join('\n\n')
    if (text !== '' || reply.tools.length > 0) {
      messages.push({ role: 'assistant', text, ...reply.tools.length > 0 ? { tools: reply.tools } : {}, at: reply.at })
    }
    reply = undefined
  }
  for (const event of events) {
    if (event.type === 'user/message') {
      // A user-role message from a schedule, a subagent, compaction, or another producer is not what
      // the user said, and does not end the reply around it.
      if (event.data.source.kind !== 'user') continue
      flush()
      const text = userText(event.data.content)
      if (text !== '') messages.push({ role: 'user', text, at: new Date(event.time).toISOString() })
    } else if (event.type === 'assistant/message') {
      reply ??= { texts: [], tools: [], at: new Date(event.time).toISOString() }
      for (const block of event.data.message.content) {
        if (block.type === 'text') {
          if (block.text.trim() !== '') reply.texts.push(block.text.trim())
        } else if (block.type === 'tool-call') {
          const summary = summaryOf(block.arguments)
          reply.tools.push(summary === undefined ? { name: block.name } : { name: block.name, summary })
        }
      }
    }
  }
  flush()
  return messages
}
