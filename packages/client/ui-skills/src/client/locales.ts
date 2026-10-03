/** Skills page copy. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  panel: 'Skills',
  installedTitle: '我安装的',
  installedIntro: '管理本机安装的 Skill：启用、停用、编辑或卸载',
  customGroup: '用户自定义',
  loading: '正在读取 Skill…',
  error: '无法读取已安装的 Skill',
  retry: '重试',
  empty: '还没有安装任何 Skill',
  loadMore: '加载更多（剩 {count} 个）',
  toggle: '启用 {name}',
  more: '{name} 的更多操作',
  chat: '去对话',
  edit: '编辑',
  reveal: '打开文件夹',
  uninstall: '卸载',
  uninstallTitle: '卸载「{name}」？',
  uninstallDescription: '整个 Skill 会被移到废纸篓，可以从废纸篓恢复。',
  uninstallCancel: '取消',
  uninstallConfirm: '卸载',
  uninstallClose: '关闭',
  actionFailed: '操作失败：{message}',
}

/** Typed key union derived from the zh source of truth. */
export type SkillsLocaleKey = keyof typeof zh

/** English dictionary. */
export const en = {
  panel: 'Skills',
  installedTitle: 'Installed',
  installedIntro: 'Manage the skills installed on this machine: enable, disable, edit, or uninstall them',
  customGroup: 'Custom',
  loading: 'Reading skills…',
  error: 'Could not read the installed skills',
  retry: 'Retry',
  empty: 'No skills installed yet',
  loadMore: 'Load more ({count} left)',
  toggle: 'Enable {name}',
  more: 'More actions for {name}',
  chat: 'Chat with it',
  edit: 'Edit',
  reveal: 'Open folder',
  uninstall: 'Uninstall',
  uninstallTitle: 'Uninstall "{name}"?',
  uninstallDescription: 'The whole skill moves to the Trash, where you can restore it.',
  uninstallCancel: 'Cancel',
  uninstallConfirm: 'Uninstall',
  uninstallClose: 'Close',
  actionFailed: 'Action failed: {message}',
} satisfies Record<SkillsLocaleKey, string>
