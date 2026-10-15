/** Copy for conversations from other computers: row mark, hover line, view-only composer, continuing, and continuation label. */

/** Simplified Chinese copy. */
export const zh = {
  'badge': '来自其他电脑：{device}',
  'hover': '来自其他电脑 · {device}',
  'readonly.title': '来自「{device}」的对话',
  'readonly.body': '在这台电脑上只能查看，不能继续对话。',
  'continue': '接着聊',
  'dialog.title': '接着聊',
  'dialog.desc': '新建一个本机对话，带上「{title}」的全部内容继续聊；原对话保持不变。',
  'dialog.untitled': '这个对话',
  'folder': '工作文件夹',
  'folder.none': '还没有选择',
  'folder.pick': '选择文件夹…',
  'folder.away': '原工作文件夹不在这台电脑上，AI 改过的文件不会带过来。',
  'folder.choose': '请选择一个本机文件夹。',
  'loading': '正在读取原工作文件夹…',
  'continuing': '正在创建接续对话…',
  'cancel': '取消',
  'close': '关闭',
  'error.folder': '这个文件夹在这台电脑上不存在，请重新选择。',
  'error.failed': '没能接着聊：{reason}',
  'continued': '接续自「{title}」',
  'continued.untitled': '接续自「{device}」的对话',
  'continued.open': '打开原对话',
}

/** English copy. */
export const en: typeof zh = {
  'badge': 'From another computer: {device}',
  'hover': 'From another computer · {device}',
  'readonly.title': 'Conversation from “{device}”',
  'readonly.body': 'On this computer it can be read, not continued.',
  'continue': 'Continue here',
  'dialog.title': 'Continue here',
  'dialog.desc': 'Start a conversation on this computer with everything in “{title}”; the original stays as it is.',
  'dialog.untitled': 'this conversation',
  'folder': 'Working folder',
  'folder.none': 'Not chosen yet',
  'folder.pick': 'Choose folder…',
  'folder.away': 'The original working folder is not on this computer, so files the AI changed there do not come along.',
  'folder.choose': 'Choose a folder on this computer.',
  'loading': 'Reading the original working folder…',
  'continuing': 'Creating the conversation…',
  'cancel': 'Cancel',
  'close': 'Close',
  'error.folder': 'That folder does not exist on this computer. Choose another.',
  'error.failed': 'Could not continue: {reason}',
  'continued': 'Continued from “{title}”',
  'continued.untitled': 'Continued from a conversation on “{device}”',
  'continued.open': 'Open the original conversation',
}

/** Keys of the copy. */
export type SessionSyncLocaleKey = keyof typeof zh

/** Locale namespace of the copy. */
export const NS = 'sessionSync'
