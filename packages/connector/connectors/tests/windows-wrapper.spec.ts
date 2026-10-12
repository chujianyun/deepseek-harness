/**
 * The Windows `lark-cli` script: `lark-cli.cmd` runs the shared Node runner, which reads the tenant's
 * settings beside it. The runner is plain Node, so it runs on every platform.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeWindowsWrapper } from '../src/cli.ts'
import { windowsWrapper } from '../src/lark.ts'
import { standInCli } from './support.ts'

const temps: string[] = []

afterEach(async () => {
  for (const directory of temps.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A stand-in lark-cli that records its arguments and lark-cli variables, and fails on `fail`. */
const STAND_IN = `#!/bin/sh
C="$(dirname "$0")"
echo "$*" >> "$C/args"
env | grep -iE '^(LARKSUITE_CLI_|LARK_CLI_|LARK_CHANNEL|OPENCLAW_|HERMES_|ELECTRON_RUN_AS_NODE|DSH_CONNECTOR_NODE)' | sort > "$C/env"
if [ "$1" = fail ]; then exit 3; fi
`

async function written(mode: 'run' | 'not-connected', bin?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-windows-wrapper-'))
  temps.push(root)
  const control = join(root, 'control')
  await mkdir(control)
  const cli = { bin: bin ?? await standInCli(control, 'lark-cli', STAND_IN), dir: join(root, 'tenant') }
  const dir = join(root, 'bin')
  await writeWindowsWrapper(dir, 'lark-cli', windowsWrapper(cli, mode, join(root, 'logs')))
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile(process.execPath, [join(dir, 'lark-cli.mjs'), ...args], { env: { ...process.env, ...env }, encoding: 'utf8' }, (error, _stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code), stderr })
    })
  })
  const args = async () => (await readFile(join(control, 'args'), 'utf8').catch(() => '')).trim().split('\n').filter(line => line !== '')
  return { root, dir, control, cli, run, args }
}

describe('the Windows lark-cli script', () => {
  it('writes the batch file, the runner, and the settings, and no staging file', async () => {
    const t = await written('run')
    expect((await readdir(t.dir)).sort()).toEqual(['lark-cli.cmd', 'lark-cli.json', 'lark-cli.mjs'])
    expect(await readFile(join(t.dir, 'lark-cli.cmd'), 'utf8')).toContain('"%DSH_CONNECTOR_NODE%" "%~dp0lark-cli.mjs" %*\r\n')
  })

  it('runs the CLI with the tenant\'s variables, without the caller\'s lark-cli variables', async () => {
    const t = await written('run')
    const result = await t.run(['calendar', '+agenda'], {
      LARKSUITE_CLI_APP_ID: 'mine', lark_cli_profile: 'mine', LARK_CHANNEL_ID: 'c', OPENCLAW_HOME: '/o', HERMES_HOME: '/h',
      ELECTRON_RUN_AS_NODE: '1', DSH_CONNECTOR_NODE: process.execPath,
    })
    expect(result.code).toBe(0)
    expect(await t.args()).toEqual(['calendar +agenda'])
    expect((await readFile(join(t.control, 'env'), 'utf8')).trim().split('\n')).toEqual([
      `LARKSUITE_CLI_CONFIG_DIR=${join(t.cli.dir, 'config')}`,
      `LARKSUITE_CLI_DATA_DIR=${join(t.cli.dir, 'data')}`,
      `LARKSUITE_CLI_LOG_DIR=${join(t.root, 'logs')}`,
      'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1',
      'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1',
    ])
  })

  it('adds --yes once to a command the user approved for this call only', async () => {
    const t = await written('run')
    const confirmed = { DSH_CONNECTOR_CONFIRMED: 'lark-cli calendar +agenda\nlark-cli drive +delete' }
    expect((await t.run(['drive', '+delete', '--file-token', 'b'], confirmed)).code).toBe(0)
    expect((await t.run(['drive', '+delete', '--yes'], confirmed)).code).toBe(0)
    expect((await t.run(['drive', '+deleted'], confirmed)).code).toBe(0)
    expect((await t.run(['drive', '+delete'])).code).toBe(0)
    expect(await t.args()).toEqual(['drive +delete --file-token b --yes', 'drive +delete --yes', 'drive +deleted', 'drive +delete'])
  })

  it('refuses lark-cli update, and runs a command that only mentions it', async () => {
    const t = await written('run')
    const result = await t.run(['update'])
    expect(result).toEqual({ code: 2, stderr: 'DSH: lark-cli update is not available here; DSH installs and updates lark-cli itself.\n' })
    expect((await t.run(['calendar', 'update'])).code).toBe(0)
    expect(await t.args()).toEqual(['calendar update'])
  })

  it('passes a failure\'s status on with a pointer to the Connectors page', async () => {
    const t = await written('run')
    const result = await t.run(['fail'])
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('DSH: lark-cli exited with status 3. If signing in to Feishu or a missing permission is the cause')
  })

  it('reports a CLI it cannot start', async () => {
    const t = await written('run', join(tmpdir(), 'dsh-no-such-lark-cli'))
    const result = await t.run(['calendar', '+agenda'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^lark-cli: .*ENOENT/u)
    expect(result.stderr).toContain('DSH: lark-cli exited with status 1.')
  })

  it('refuses everything while the tenant is not connected', async () => {
    const t = await written('not-connected')
    const result = await t.run(['calendar', '+agenda'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('DSH: the Feishu connector is not connected for this company.')
    expect(await t.args()).toEqual([])
  })

  it.runIf(process.platform === 'win32')('refuses outside a DSH shell call, which names the Node', async () => {
    const t = await written('run')
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'DSH_CONNECTOR_NODE'))
    const code = await new Promise<number>((resolve) => {
      execFile(`"${join(t.dir, 'lark-cli.cmd')}"`, ['calendar'], { env, shell: true }, (error) => { resolve(error === null ? 0 : Number(error.code)) })
    })
    expect(code).toBe(2)
    expect(await t.args()).toEqual([])
  })
})
