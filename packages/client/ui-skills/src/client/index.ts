/**
 * Skills page, browser half: the **Skills** entry of the sidebar and the page it opens in the main
 * column. The page browses the Skill Hub market and installs from it through the `skillMarket` Remote,
 * and lists the skills installed on this machine through the `installedSkills` Remote,
 * switches them on and off, and opens, edits, reveals, or uninstalls one.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createInstalledSource } from './installed-source.ts'
import { createMarketSource } from './market-source.ts'
import { en, zh, type SkillsLocaleKey } from './locales.ts'
import { SkillsPage } from './SkillsPage.tsx'
import { SkillsPanelIcon } from './SkillsPanelIcon.tsx'

export type { InstalledSkillsInjected, InstalledSnapshot } from './installed-source.ts'
export type { MarketInjected, MarketSnapshot } from './market-source.ts'
export type { SkillsLocaleKey } from './locales.ts'
export type { SkillsInjected, SkillsPageProps } from './SkillsPage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Skills page copy. */
    'skills': SkillsLocaleKey
  }
}

const NS = 'skills'
const PANEL_ID = 'skills' as MainPanelId

/** Services the page reads: the installed-skill and market Remotes, and Session navigation with draft access for "chat with it". */
export const inject = ['slots', 'locale', 'remote', 'remote.installedSkills', 'remote.skillMarket', 'uiWorkspace', 'sessions', 'conversation']

/**
 * Contribute the Skills sidebar entry and the page it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skills: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.installedSkills
  const installed = createInstalledSource({
    list: () => remote.list(),
    setEnabled: (name, enabled) => remote.setEnabled(name, enabled),
    reveal: name => remote.reveal(name),
    edit: name => remote.edit(name),
    uninstall: name => remote.uninstall(name),
    // A new Session in the usual New Session Workspace, its draft invoking the skill without sending.
    chat: (name) => {
      ctx.uiWorkspace.startSession(undefined, (sessionId) => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding !== undefined) ctx.conversation.input.for(binding.ctx).setDraft(`/${name} `)
      })
    },
  })
  const market = ctx.remote.skillMarket
  const marketFace = createMarketSource({
    list: query => market.list(query),
    categories: () => market.categories(),
    detail: id => market.detail(id),
    install: (id, options) => market.installSkill(id, options),
    installedStatus: () => market.installedStatus(),
    installed: () => { void installed.onRefresh() },
  })
  const face = { ...installed, ...marketFace, hooks: { ...installed.hooks, ...marketFace.hooks } }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => face,
  }, SkillsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 5,
    label: () => t('panel'),
    locale: NS,
  }, SkillsPanelIcon))
}
