/**
 * Signing a tenant in to Feishu, checking the connection, and disconnecting, over a stand-in
 * lark-cli: a shell script that prints what the real CLI prints at each step and waits for the spec
 * to finish the step through control files beside it.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { failureMessage } from '../src/lark.ts'
import { feishu, setup, VERSION } from './support.ts'

const runs = it.skipIf(process.platform === 'win32')

describe('connecting Feishu', () => {
  runs('creates the tenant\'s app, authorizes the user, and turns green, in the tenant\'s own directories', async () => {
    vi.stubEnv('LARKSUITE_CLI_APP_ID', 'cli_users_own_app')
    vi.stubEnv('OPENCLAW_HOME', '/somewhere')
    const t = await setup()
    await t.until(view => view.status === 'disconnected')
    await t.service.connect('feishu')
    const app = await t.until(view => view.login?.qrCode != null)
    expect(app).toMatchObject({
      status: 'connecting',
      login: { step: 'create-app', url: 'https://open.feishu.cn/page/cli?user_code=APP-1', qrCode: `data:image/png;base64,${Buffer.from('PNG').toString('base64')}` },
    })
    await t.answer('app', 'ok')
    const user = await t.until(view => view.login?.step === 'authorize' && view.login.url !== null)
    expect(user.login?.url).toBe('https://accounts.feishu.cn/verify?user_code=USER-1')
    await t.answer('user', 'ok')
    expect(await t.until(view => view.status === 'connected')).toMatchObject({ account: '韩梅梅', login: null, loginError: null, problem: null })
    const env = (await readFile(join(t.control, 'env'), 'utf8')).trim().split('\n')
    expect(env).toEqual([
      `LARKSUITE_CLI_CONFIG_DIR=${join(t.tenantDir('t-a'), 'config')}`,
      `LARKSUITE_CLI_DATA_DIR=${join(t.tenantDir('t-a'), 'data')}`,
      `LARKSUITE_CLI_LOG_DIR=${join(t.tenantDir('t-a'), 'logs')}`,
      'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1',
      'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1',
    ])
    expect(await t.calls()).toEqual(expect.arrayContaining(['config init --new --brand feishu', 'auth login --recommend --json']))
    // Connecting a connected connector changes nothing.
    const before = (await t.calls()).length
    await t.service.connect('feishu')
    expect((await t.calls()).length).toBe(before)
  })

  runs('reports an app the platform refused to create, and leaves nothing behind', async () => {
    const t = await setup()
    await t.until(view => view.status === 'disconnected')
    await t.service.connect('feishu')
    await t.until(view => view.login?.url != null)
    await t.answer('app', 'fail:the tenant does not allow employees to create apps')
    const failed = await t.until(view => view.status === 'disconnected')
    expect(failed.loginError).toEqual({ step: 'create-app', message: 'the tenant does not allow employees to create apps' })
    expect(await t.exists(t.tenantDir('t-a'))).toBe(false)
  })

  runs('removes the app it created when the user does not authorize', async () => {
    const t = await setup()
    await t.service.connect('feishu')
    await t.until(view => view.login?.step === 'create-app' && view.login.url !== null)
    await t.answer('app', 'ok')
    await t.until(view => view.login?.step === 'authorize' && view.login.url !== null)
    await t.answer('user', 'fail:authorization expired')
    expect((await t.until(view => view.status === 'disconnected')).loginError).toEqual({ step: 'authorize', message: 'authorization expired' })
    expect(await t.calls()).toContain('config remove')
    expect(await t.exists(t.tenantDir('t-a'))).toBe(false)
  })

  runs('cancels a sign-in, removing the app it created, and can connect again', async () => {
    const t = await setup()
    await t.service.connect('feishu')
    await t.until(view => view.login?.url != null)
    await t.answer('app', 'ok')
    await t.until(view => view.login?.step === 'authorize' && view.login.url !== null)
    expect(feishu(await t.service.cancelConnect('feishu'))).toMatchObject({ status: 'disconnected', login: null, loginError: null })
    expect(await t.exists(t.tenantDir('t-a'))).toBe(false)
    await t.service.connect('feishu')
    expect(feishu(await t.service.getState()).status).toBe('connecting')
    await t.service.cancelConnect('feishu')
  })

  runs('only authorizes when the tenant already has its app, and keeps the app when that fails', async () => {
    const t = await setup()
    await mkdir(join(t.tenantDir('t-a'), 'config'), { recursive: true })
    await writeFile(join(t.tenantDir('t-a'), 'config', 'config.json'), '{}')
    await t.service.check()
    await t.service.connect('feishu')
    expect((await t.until(view => view.login?.url != null)).login?.step).toBe('authorize')
    await t.answer('user', 'fail:denied')
    await t.until(view => view.status === 'disconnected')
    expect(await t.calls()).not.toContain('config init --new --brand feishu')
    expect(await t.exists(join(t.tenantDir('t-a'), 'config', 'config.json'))).toBe(true)
  })

  runs('finishes at once when the tenant is already signed in, and draws no QR code when the CLI cannot', async () => {
    const t = await setup()
    await writeFile(join(t.control, 'noqr'), '')
    await t.service.connect('feishu')
    expect((await t.until(view => view.login?.url != null)).login?.qrCode).toBeNull()
    await t.answer('app', 'ok')
    await t.until(view => view.login?.step === 'authorize' && view.login.url !== null)
    await t.status({ identities: { user: { status: 'ready', userName: '韩梅梅' } } })
    await t.answer('user', 'ok')
    await t.until(view => view.status === 'connected')
    await t.service.disconnect('feishu')
    await mkdir(join(t.tenantDir('t-a'), 'config'), { recursive: true })
    await t.service.connect('feishu')
    expect((await t.until(view => view.status !== 'connecting')).status).toBe('connected')
  })
})

describe('connection health', () => {
  runs.each([
    [{ identities: { user: { status: 'ready', userName: '韩梅梅' } } }, { status: 'connected', account: '韩梅梅' }],
    [{ identities: { user: { status: 'needs_refresh' } } }, { status: 'connected', account: null }],
    [{ identities: { user: { status: 'missing' } } }, { status: 'disconnected' }],
    [{ identities: { user: { status: 'not_configured' } } }, { status: 'disconnected' }],
    [{ ok: false, error: { type: 'config', subtype: 'not_configured' } }, { status: 'disconnected' }],
    [{ identities: { user: { status: 'verify_failed', message: 'User identity: verify failed: token unusable: refresh failed' } } },
      { status: 'degraded', problem: 'User identity: verify failed: token unusable: refresh failed' }],
    [{ ok: false, error: { type: 'network', message: 'dial tcp: i/o timeout' } }, { status: 'degraded', problem: 'dial tcp: i/o timeout' }],
    ['not json at all', { status: 'degraded', problem: 'not json at all' }],
  ])('reads %j as %j', async (output, expected) => {
    const t = await setup()
    await t.status(output)
    expect(feishu(await t.service.check())).toMatchObject(expected)
  })

  runs('reports a CLI that cannot run as degraded, and a sign-in through it as failed', async () => {
    const t = await setup()
    await rm(join(t.root, VERSION, 'lark-cli'))
    expect(feishu(await t.service.check())).toMatchObject({ status: 'degraded', problem: expect.stringContaining('ENOENT') as string })
    await t.service.connect('feishu')
    expect((await t.until(view => view.status !== 'connecting')).loginError).toMatchObject({ step: 'authorize', message: expect.stringContaining('ENOENT') as string })
    // Disconnecting still deletes the tenant's directory when config remove cannot run.
    await mkdir(t.tenantDir('t-a'), { recursive: true })
    await t.service.disconnect('feishu')
    expect(await t.exists(t.tenantDir('t-a'))).toBe(false)
  })

  runs('checks again on a timer', async () => {
    const t = await setup({ checkIntervalMs: 1000 })
    await t.service.check()
    await t.status({ identities: { user: { status: 'ready' } } })
    expect((await t.until(view => view.status === 'connected')).status).toBe('connected')
  })

  runs('reconnects a degraded connection by authorizing again', async () => {
    const t = await setup()
    await t.status({ identities: { user: { status: 'error', message: 'keychain locked' } } })
    expect(feishu(await t.service.check())).toMatchObject({ status: 'degraded', problem: 'keychain locked' })
    await t.service.connect('feishu')
    expect((await t.until(view => view.login?.url != null)).login?.step).toBe('authorize')
    await t.service.cancelConnect('feishu')
  })
})

describe('disconnecting, tenants, and uninstalling', () => {
  runs('disconnects: the tenant\'s sign-in is deleted and the CLI stays', async () => {
    const t = await setup()
    await t.service.connect('feishu')
    await t.until(view => view.login?.url != null)
    await t.answer('app', 'ok')
    await t.until(view => view.login?.step === 'authorize' && view.login.url !== null)
    await t.answer('user', 'ok')
    await t.until(view => view.status === 'connected')
    expect(feishu(await t.service.disconnect('feishu'))).toMatchObject({ status: 'disconnected', account: null })
    expect(await t.calls()).toContain('config remove')
    expect(await t.exists(t.tenantDir('t-a'))).toBe(false)
    expect(await t.exists(join(t.root, VERSION, 'lark-cli'))).toBe(true)
  })

  runs('keeps each tenant\'s connection apart and stops a sign-in when the tenant changes', async () => {
    const t = await setup()
    await mkdir(join(t.tenantDir('t-a'), 'config'), { recursive: true })
    await writeFile(join(t.tenantDir('t-a'), 'config', 'config.json'), '{}')
    await writeFile(join(t.tenantDir('t-a'), 'config', 'user'), '韩梅梅')
    expect(feishu(await t.service.check()).status).toBe('connected')
    // The same tenant signing in again changes nothing.
    t.hub.set('t-a')
    await new Promise(resolve => setTimeout(resolve, 50))
    t.hub.set('t-b')
    expect((await t.until(view => view.status === 'disconnected')).account).toBeNull()
    await t.service.connect('feishu')
    await t.until(view => view.login?.url != null)
    t.hub.set('t-a')
    expect((await t.until(view => view.status === 'connected')).account).toBe('韩梅梅')
    expect(await t.exists(t.tenantDir('t-b'))).toBe(false)
    t.hub.set(null)
    expect((await t.until(view => view.status === 'disconnected')).account).toBeNull()
  })

  runs('uninstalls: every tenant\'s sign-in and the CLI are deleted', async () => {
    const t = await setup()
    for (const tenant of ['t-a', 't-b']) {
      await mkdir(join(t.tenantDir(tenant), 'config'), { recursive: true })
      await writeFile(join(t.tenantDir(tenant), 'config', 'config.json'), '{}')
    }
    await t.service.connect('feishu')
    await t.until(view => view.login?.url != null)
    expect(feishu(await t.service.uninstallConnector('feishu'))).toMatchObject({ status: 'not-installed', login: null })
    expect(await t.exists(t.root)).toBe(false)
  })

  it('refuses to connect while signed out of the Hub or before the CLI is installed, and checks nothing then', async () => {
    const signedOut = await setup({ tenant: null })
    expect(feishu(await signedOut.service.check()).status).toBe('disconnected')
    for (const call of [() => signedOut.service.connect('feishu'), () => signedOut.service.disconnect('feishu')]) {
      expect(remoteErrorOf(await call().catch((error: unknown) => error))?.code).toBe('hub-account/signed-out')
    }
    const missing = await setup({ installed: false })
    expect(remoteErrorOf(await missing.service.connect('feishu').catch((error: unknown) => error))?.code).toBe('connectors/not-installed')
    expect(feishu(await missing.service.disconnect('feishu')).status).toBe('not-installed')
    expect(remoteErrorOf(await missing.service.cancelConnect('wecom').catch((error: unknown) => error))?.code).toBe('connectors/not-found')
  })

  runs('stops a sign-in quietly when the plugin is disposed', async () => {
    const t = await setup()
    await t.service.connect('feishu')
    await t.until(view => view.login?.url != null)
    await t.ctx.fiber.dispose()
    expect(feishu(await t.service.getState()).status).toBe('connecting')
  })
})

describe('failure messages', () => {
  it('prefers a JSON error, then the last text lines without QR art, then the exit code', () => {
    expect(failureMessage({ code: 1, stdout: '{"ok":false,"error":{"message":"denied"}}', stderr: '' })).toBe('denied')
    expect(failureMessage({ code: 1, stdout: '', stderr: '█▀▄\nfirst\nsecond\nthird\n' })).toBe('second third')
    expect(failureMessage({ code: 7, stdout: '', stderr: '' })).toBe('exit code 7')
    expect(failureMessage({ code: 1, stdout: '42', stderr: '' })).toBe('42')
    expect(failureMessage({ code: 2, stdout: '{"event":"device_authorization"}\n{"event":"authorization_failed","error":"expired"}\n', stderr: '' })).toBe('expired')
    expect(failureMessage({ code: 3, stdout: '', stderr: '{\n  "ok": false,\n  "error": { "type": "config", "message": "not configured" }\n}' })).toBe('not configured')
  })
})
