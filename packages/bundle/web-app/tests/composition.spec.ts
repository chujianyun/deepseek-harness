/** The web bundle's shipped composition: no built-in telemetry egress, retained account and brand rows. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface PatchRow { id?: string; name?: string; disabled?: unknown }

function composition(): { manifest: { dependencies?: Record<string, string> }; text: string; rows: PatchRow[] } {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> }
  const text = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
  const parsed = yaml.load(text, { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('web-app patch must parse to a patch list')
  const rows = (parsed as { insert?: PatchRow[] }[]).flatMap(patch => patch.insert ?? [])
  return { manifest, text, rows }
}

describe('dsh-web-app composition', () => {
  it('mounts no product analytics or telemetry exporter for any profile', () => {
    const { manifest, text, rows } = composition()
    // The personal edition ships no Desktop analytics intake and no OTLP
    // exporter: both rows are gone for the desktop and web profiles alike,
    // instead of being gated off per profile.
    expect(rows.some(row => row.id === 'desktop-product-telemetry')).toBe(false)
    expect(rows.some(row => row.id === 'product-analytics')).toBe(false)
    expect(text).not.toContain('DSH_PRODUCT_ANALYTICS_OTLP_URL')
    expect(text).not.toContain('deepseeksvc')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-host-product-telemetry-otel')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-client-product-analytics')
  })

  it('retains the platform account, message feedback, and local brand rows', () => {
    const { rows } = composition()
    // DeepSeek platform account management stays available to the desktop and
    // web surfaces; feedback keeps its local Session-log services; the
    // official brand occupants stay local resources.
    expect(rows.some(row => row.id === 'account-controller')).toBe(true)
    expect(rows.some(row => row.id === 'ui-settings-account')).toBe(true)
    expect(rows.some(row => row.id === 'message-feedback')).toBe(true)
    expect(rows.some(row => row.id === 'ui-message-feedback')).toBe(true)
    expect(rows.some(row => row.id === 'ui-brand-official')).toBe(true)
  })
})
