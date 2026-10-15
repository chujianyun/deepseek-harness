/** Copy for conversations from other computers: the row mark, its hover line, and the view-only composer. */

/** Simplified Chinese copy. */
export const zh = {
  'badge': '来自其他电脑：{device}',
  'hover': '来自其他电脑 · {device}',
  'readonly.title': '来自「{device}」的对话',
  'readonly.body': '在这台电脑上只能查看，不能继续对话。',
}

/** English copy. */
export const en: typeof zh = {
  'badge': 'From another computer: {device}',
  'hover': 'From another computer · {device}',
  'readonly.title': 'Conversation from “{device}”',
  'readonly.body': 'On this computer it can be read, not continued.',
}

/** Keys of the copy. */
export type SessionSyncLocaleKey = keyof typeof zh

/** Locale namespace of the copy. */
export const NS = 'sessionSync'
