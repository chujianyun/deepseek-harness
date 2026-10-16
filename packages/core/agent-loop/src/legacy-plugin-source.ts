/** Adoption of the released V3 plugin source wrapper still produced by third-party plugins. */

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { releasedV3ProducerKind } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

/**
 * Rename each `{ kind: 'plugin', plugin }` source to the kind the V3-to-V4 migration assigns,
 * keeping other fields and the message identity.
 * @param messages - messages entering the inbox or accepted by `agent/pre-step`.
 * @returns `messages` itself when no source needs adoption, otherwise a copy with frozen adopted messages.
 * @throws Error when a `plugin` source lacks a string `plugin` name, as migration refuses it, before the message becomes model-visible.
 */
export function adoptLegacyPluginSources<T extends readonly UserMessage[]>(messages: T): T {
  const adopted = messages.map(adoptLegacyPluginSource)
  return adopted.every((message, index) => message === messages[index]) ? messages : adopted as readonly UserMessage[] as T
}

function adoptLegacyPluginSource(message: UserMessage): UserMessage {
  const source: { readonly kind: string; readonly plugin?: unknown } = message.source
  if (source.kind !== 'plugin') return message
  if (typeof source.plugin !== 'string') {
    throw new Error('agent-loop: a message source of kind "plugin" requires a string plugin name')
  }
  const { plugin, ...fields } = source
  // The adopted kind may belong to a third-party producer undeclared in MessageSourceMap; readers fall through unknown kinds.
  const renamed: { readonly kind: string } = { ...fields, kind: releasedV3ProducerKind(plugin, message.role) }
  return deepFreeze({ ...message, source: renamed as MessageSource })
}
