/** Which rows the enterprise Desktop (the desktop profile with a user center) composes, against Desktop without one and Web. */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const rows = loadOverlayPatches('enterprise', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))).flatMap(patch => patch.insert ?? [])

/** Evaluate a row's `disabled` the way the Loader does: a literal, or a `!!js` expression over `ctx` and `process`. */
function disabled(id: string, profile: string, hubOrigin: string | undefined): boolean {
  const row = rows.find(entry => entry.id === id)
  if (row === undefined) throw new Error(`no row ${id}`)
  const value = row.disabled as boolean | { __jsExpr: string } | undefined
  if (value === undefined || typeof value === 'boolean') return value ?? false
  const ctx = { get: (name: string) => (name === 'profileContext' ? { name: profile } : undefined) }
  const env = hubOrigin === undefined ? {} : { DSH_HUB_ORIGIN: hubOrigin }
  // The bundle's own !!js expressions, evaluated over the same names the Loader provides.
  // oxlint-disable-next-line typescript/no-implied-eval
  const evaluate = new Function('ctx', 'process', `return (${value.__jsExpr})`) as (ctx: object, process: object) => unknown
  return Boolean(evaluate(ctx, { env }))
}

const LEFT_OUT = ['open-in-app', 'ui-open-in-app', 'session-log-download', 'ui-plugin-manager', 'ui-settings-plugins',
  'ui-settings-plugin-inventory', 'ui-settings-shell', 'ui-settings-agent-loop', 'ui-settings-subagent', 'ui-settings-web-search']
const ENTERPRISE_ONLY = ['feedback-report', 'ui-feedback-report', 'session-share', 'ui-session-share']

describe('enterprise Desktop composition', () => {
  it('leaves out Open In, Session log export, and the plugin pages, and composes problem reports and sharing', () => {
    for (const id of LEFT_OUT) expect(disabled(id, 'desktop', 'https://hub.example'), id).toBe(true)
    for (const id of ENTERPRISE_ONLY) expect(disabled(id, 'desktop', 'https://hub.example'), id).toBe(false)
  })

  it.each([['desktop', undefined], ['web', 'https://hub.example'], ['web', undefined]])('keeps Open In, log export, and the plugin pages for %s with user center %s', (profile, hub) => {
    for (const id of LEFT_OUT) expect(disabled(id, profile, hub), id).toBe(false)
    for (const id of ENTERPRISE_ONLY) expect(disabled(id, profile, hub), id).toBe(true)
  })
})
