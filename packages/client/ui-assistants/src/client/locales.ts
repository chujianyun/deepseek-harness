/** Assistants page and new-session picker copy. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  panel: '智能体',
  title: '智能体',
  intro: '把常用的工作角色做成智能体：每个智能体有自己的身份、人格和工作方法。新会话时选一个智能体，它就按这些设定工作。',
  searchPlaceholder: '搜索智能体',
  count: '{count} 个智能体',
  default: '默认',
  chat: '对话',
  empty: '还没有智能体。',
  noMatch: '没有找到匹配的智能体，试试别的关键词。',
  signedOut: '登录用户中心后可以使用智能体。',
  pickerHint: '选择这个会话的智能体',
  selectFailed: '无法切换智能体：{message}',
  noDescription: '暂无描述',
  dismiss: '关闭',
} as const

/** Locale key union of the Assistants copy. */
export type AssistantsLocaleKey = keyof typeof zh

/** English dictionary. */
export const en = {
  panel: 'Assistants',
  title: 'Assistants',
  intro: 'Turn the roles you work with into assistants, each with its own identity, personality, and working method. Pick one when starting a session and it works the way you set it up.',
  searchPlaceholder: 'Search assistants',
  count: '{count} assistants',
  default: 'Default',
  chat: 'Chat',
  empty: 'No assistants yet.',
  noMatch: 'No assistant matches. Try another keyword.',
  signedOut: 'Sign in to the user center to use assistants.',
  pickerHint: 'Choose the assistant for this session',
  selectFailed: 'Could not switch the assistant: {message}',
  noDescription: 'No description',
  dismiss: 'Dismiss',
} satisfies Record<AssistantsLocaleKey, string>
