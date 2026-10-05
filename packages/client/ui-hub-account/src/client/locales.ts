/** Hub account section copy. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  signedOut: '未登录 Skill Hub',
  signedOutIntro: '使用公司账号登录后，才能浏览、安装和上传 Skill。登录会在系统浏览器中完成。',
  checking: '正在检查登录状态…',
  expired: '登录已失效（账号或租户被停用、授权被撤销或已过期），请重新登录。正在运行的会话不受影响，重新登录前不能发送新消息。',
  signIn: '登录 Skill Hub',
  waiting: '已在浏览器中打开登录页，请在浏览器中完成登录。',
  reopen: '重新打开登录页',
  exchanging: '正在完成登录…',
  cancel: '取消',
  retry: '重新登录',
  'error.denied': '授权未通过：你在浏览器中拒绝了授权，或该账号无权登录 DSH（超级管理员不属于任何公司）。',
  'error.expired': '登录超时，请重新登录。',
  'error.network': '无法连接用户中心，请检查网络后重试。',
  'error.protocol': '登录失败，请重试。',
  'error.storage': '无法保存登录信息，请重试。',
  actionFailed: '操作失败：{message}',
  section: 'Skill Hub 账号',
  tenant: '租户',
  noTenant: '不属于任何公司',
  phone: '手机号',
  switchTenant: '切换租户',
  signOut: '退出登录',
}

/** Typed key union derived from the zh source of truth. */
export type HubAccountLocaleKey = keyof typeof zh

/** English dictionary. */
export const en = {
  signedOut: 'Not signed in to Skill Hub',
  signedOutIntro: 'Sign in with your company account to browse, install, and upload Skills. Sign-in happens in your system browser.',
  checking: 'Checking sign-in…',
  expired: 'Your sign-in has ended (account or tenant disabled, authorization revoked, or expired). Sign in again. Running sessions continue, but you cannot send new messages until you sign in.',
  signIn: 'Sign in to Skill Hub',
  waiting: 'The sign-in page is open in your browser. Finish signing in there.',
  reopen: 'Open the sign-in page again',
  exchanging: 'Finishing sign-in…',
  cancel: 'Cancel',
  retry: 'Sign in again',
  'error.denied': 'Authorization was not granted: you declined it, or this account may not sign in to DSH (a super administrator belongs to no company).',
  'error.expired': 'Sign-in timed out. Sign in again.',
  'error.network': 'Could not reach the user center. Check your network and try again.',
  'error.protocol': 'Sign-in failed. Try again.',
  'error.storage': 'Could not save the sign-in. Try again.',
  actionFailed: 'Action failed: {message}',
  section: 'Skill Hub account',
  tenant: 'Tenant',
  noTenant: 'No company',
  phone: 'Phone',
  switchTenant: 'Switch tenant',
  signOut: 'Sign out',
} satisfies Record<HubAccountLocaleKey, string>
