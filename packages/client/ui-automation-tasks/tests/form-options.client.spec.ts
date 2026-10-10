import { describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { loadTaskFormOptions } from '../src/client/form-options.ts'

const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })

describe('reading the form\'s options', () => {
  it('offers the assistants, the models by provider, the presets but custom, and the connected connectors', async () => {
    const options = await loadTaskFormOptions({
      assistants: () => ok({ assistants: [{ id: 'a1', name: '电商管家' }] }),
      models: () => ok({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'v4', name: 'V4' }] }] }),
      permissions: () => ok({
        options: [{ value: 'workspace-write', name: '工作区内修改' }, { value: 'custom', name: '自定义' }, { value: 'auto', name: 'Auto' }],
        defaultPreset: 'workspace-write',
      }),
      connectors: () => ok({ connectors: [{ id: 'feishu', status: 'connected' }, { id: 'dingtalk', status: 'disconnected' }, { id: 'x', status: 'degraded' }] }),
    })
    expect(options).toEqual({
      assistants: [{ value: 'a1', label: '电商管家' }],
      models: [{ value: JSON.stringify(['deepseek', 'v4']), label: 'DeepSeek · V4' }],
      permissions: [{ value: 'workspace-write', label: '工作区内修改' }],
      defaultPermission: 'workspace-write',
      connectors: ['feishu', 'x'],
    })
  })

  it('offers nothing from a source that refuses or throws', async () => {
    const options = await loadTaskFormOptions({
      assistants: () => Promise.resolve({ ok: false as const, error: new RemoteError('hub-account/signed-out', 'out', {}) }),
      models: () => Promise.reject(new Error('gone')),
      permissions: () => { throw new Error('absent') },
      connectors: () => Promise.resolve({ ok: false as const, error: new RemoteError('hub-account/signed-out', 'out', {}) }),
    })
    expect(options).toEqual({ assistants: [], models: [], permissions: [], defaultPermission: '', connectors: [] })
  })
})
