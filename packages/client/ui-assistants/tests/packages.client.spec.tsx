// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AssistantPackageManifest, AssistantPackagesState, InstalledPackageView } from '@deepseek-ai/dsh-assistant-packages/client'
import type { AssistantDetail, AssistantsState } from '@deepseek-ai/dsh-assistants/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { AssistantsSnapshot } from '../src/client/assistants-source.ts'
import { AssistantsPage } from '../src/client/AssistantsPage.tsx'
import { en, zh } from '../src/client/locales.ts'
import { createPackagesSource, PACKAGES_BUSY, type PackagesSnapshot } from '../src/client/packages-source.ts'
import { CompanyPackages, PackageTasks, timingText } from '../src/client/PackageViews.tsx'

afterEach(() => { cleanup() })

const MANIFEST: AssistantPackageManifest = {
  name: 'ops-report', displayName: '运营日报助手', description: '每天巡检与日报', version: '1.0.0', avatar: 'ocean', skills: ['ai-inspection'],
  tasks: [
    { id: 'inspection', title: '部门巡检', prompt: 'p', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '11:00' }, timeZone: 'Asia/Shanghai' },
    { id: 'report', title: '天猫日报', prompt: 'p', timing: { kind: 'cron', expression: '0 6 * * 1-5' }, timeZone: 'Asia/Shanghai' },
  ],
}

const installedView = (overrides: Partial<InstalledPackageView> = {}): InstalledPackageView => ({
  assistantId: 'a9', packageId: 'pkg-1', name: 'ops-report', displayName: '运营日报助手', version: '1.0.0', updateVersion: null, missingSkills: [],
  tasks: [
    { ...MANIFEST.tasks[0]!, enabled: null, outdated: false },
    { ...MANIFEST.tasks[1]!, enabled: { sessionId: 's1', scheduleId: 'sch1', version: '1.0.0' }, outdated: true },
  ],
  ...overrides,
})

const packagesState = (overrides: Partial<AssistantPackagesState> = {}): AssistantPackagesState => ({
  tenantId: 't-a', unavailable: false,
  packages: [{ id: 'pkg-1', name: 'ops-report', version: '1.0.0', manifest: MANIFEST, updatedAt: '2026-10-13T00:00:00Z', installedAssistantId: null }],
  installed: [],
  ...overrides,
})

function faces(state: AssistantPackagesState | undefined, running: string | null = null) {
  const packages = createSnapshotStore<PackagesSnapshot>({ state, running })
  const workspaces = createSnapshotStore({ items: [{ workspaceId: 'ws-1', title: 'default-workspace' }, { workspaceId: 'ws-2', title: '名流项目' }] } as never)
  return {
    packages,
    props: {
      t: makeTranslate(zh), usePackages: bindSnapshotSelector(packages), useWorkspaces: bindSnapshotSelector(workspaces),
      onPackagesRefresh: vi.fn(async () => {}),
      onPackageInstall: vi.fn(async (_id: string) => ({ assistantId: 'a9', version: '1.0.0', installedSkills: ['roi-inspection'], missingSkills: ['gone-skill'], keptFiles: [] }) as const),
      onPackageUpdate: vi.fn(async (_id: string) => ({ assistantId: 'a9', version: '1.1.0', installedSkills: [], missingSkills: [], keptFiles: ['SOUL.md'] }) as const),
      onTaskEnable: vi.fn(async (_a: string, _t: string, _w: string): Promise<string | undefined> => undefined),
      onTaskDisable: vi.fn(async (_a: string, _t: string): Promise<string | undefined> => undefined),
    },
  }
}

describe('timing text', () => {
  const t = makeTranslate(zh)
  it('reads daily, cron, consecutive and scattered weekdays, and every day', () => {
    expect(timingText(t, { kind: 'daily', time: '09:30' })).toBe('每天 09:30')
    expect(timingText(t, { kind: 'cron', expression: '0 6 * * 1-5' })).toBe('按 cron「0 6 * * 1-5」')
    expect(timingText(t, { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '11:00' })).toBe('周一至周五 11:00')
    expect(timingText(t, { kind: 'weekly', weekdays: [1, 3, 5], time: '10:00' })).toBe('周一、周三、周五 10:00')
    expect(timingText(t, { kind: 'weekly', weekdays: [1, 2], time: '10:00' })).toBe('周一、周二 10:00')
    expect(timingText(t, { kind: 'weekly', weekdays: [1, 2, 3, 4, 5, 6, 7], time: '08:00' })).toBe('每天 08:00')
    expect(timingText(makeTranslate(en), { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '11:00' })).toBe('Mon to Fri at 11:00')
  })
})

describe('company section', () => {
  it('shows nothing before the first read, while signed out, or when the company published none', () => {
    for (const state of [undefined, packagesState({ tenantId: null }), packagesState({ packages: [] })]) {
      const { props } = faces(state)
      const { container } = render(<CompanyPackages {...props} onOpen={vi.fn()} />)
      expect(container.textContent).toBe('')
      expect(props.onPackagesRefresh).toHaveBeenCalled()
      cleanup()
    }
  })

  it('draws the default avatar for a package that names none', () => {
    const { avatar: _avatar, ...bare } = MANIFEST
    const { props } = faces(packagesState({ packages: [{ ...packagesState().packages![0]!, manifest: bare }] }))
    render(<CompanyPackages {...props} onOpen={vi.fn()} />)
    expect(screen.getByText('运营日报助手', { selector: 'span' })).toBeTruthy()
  })

  it('says the list cannot be read when the user center is unreachable', () => {
    const { props } = faces(packagesState({ packages: null, unavailable: true }))
    render(<CompanyPackages {...props} onOpen={vi.fn()} />)
    expect(screen.getByText(zh.companyUnavailable)).toBeTruthy()
  })

  it('installs a package and reports the Skills installed and missing', async () => {
    const { props } = faces(packagesState())
    render(<CompanyPackages {...props} onOpen={vi.fn()} />)
    expect(screen.getByText('版本 1.0.0 · 推荐定时任务 2 条')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '安装' })) })
    expect(props.onPackageInstall).toHaveBeenCalledWith('pkg-1')
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('已安装「运营日报助手」。')
    expect(status.textContent).toContain('已从 Skill Hub 安装技能：roi-inspection。')
    expect(status.textContent).toContain('请联系管理员：gone-skill。')
    fireEvent.click(within(status).getByRole('button', { name: zh.dismiss }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the busy refusal in the user\'s language', async () => {
    const { props } = faces(packagesState())
    props.onPackageInstall.mockResolvedValueOnce(PACKAGES_BUSY as never)
    render(<CompanyPackages {...props} onOpen={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '安装' })) })
    expect(screen.getByRole('alert').textContent).toBe('操作失败：上一个操作还没完成，请稍候关闭')
  })

  it('shows a refusal as an alert', async () => {
    const { props } = faces(packagesState())
    props.onPackageInstall.mockResolvedValueOnce('the user center answered 500' as never)
    render(<CompanyPackages {...props} onOpen={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '安装' })) })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：the user center answered 500')
  })

  it('opens an installed package\'s assistant, and offers the newer version', async () => {
    const state = packagesState({ installed: [installedView()], packages: [{ ...packagesState().packages![0]!, installedAssistantId: 'a9' }] })
    const onOpen = vi.fn()
    const { props, packages } = faces(state)
    render(<CompanyPackages {...props} onOpen={onOpen} />)
    expect(screen.getByText(zh.installed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(onOpen).toHaveBeenCalledWith('a9')

    act(() => { packages.set({ state: { ...state, installed: [installedView({ updateVersion: '1.1.0' })] }, running: null }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新到 1.1.0' })) })
    expect(props.onPackageUpdate).toHaveBeenCalledWith('a9')
    expect(screen.getByRole('status').textContent).toContain('你改过的文件保留了原样：SOUL.md。')

    act(() => { packages.set({ state: { ...state, installed: [installedView({ updateVersion: '1.1.0' })] }, running: 'a9' }) })
    expect(screen.getByRole('button', { name: '正在更新…' })).toHaveProperty('disabled', true)
    act(() => { packages.set({ state: packagesState(), running: 'pkg-1' }) })
    expect(screen.getByRole('button', { name: '正在安装…' })).toBeTruthy()
  })
})

describe('recommended tasks', () => {
  it('shows nothing for an assistant not installed from a package', () => {
    const { props } = faces(packagesState())
    const { container } = render(<PackageTasks {...props} assistantId="a1" />)
    expect(container.textContent).toBe('')
  })

  it('lists the tasks with their timing and state, the outdated note, and missing Skills', () => {
    const { props } = faces(packagesState({ installed: [installedView({ missingSkills: ['gone-skill'] })] }))
    render(<PackageTasks {...props} assistantId="a9" />)
    expect(screen.getByText('来自企业智能体包「运营日报助手」，版本 1.0.0。')).toBeTruthy()
    const [inspection, report] = screen.getAllByRole('listitem')
    expect(inspection!.textContent).toContain('周一至周五 11:00 · 未开启')
    expect(report!.textContent).toContain('按 cron「0 6 * * 1-5」 · 已开启')
    expect(report!.textContent).toContain(zh.taskOutdated)
    expect(screen.getByRole('alert').textContent).toContain('gone-skill')
  })

  it('says when the package has no tasks', () => {
    const { props } = faces(packagesState({ installed: [installedView({ tasks: [] })] }))
    render(<PackageTasks {...props} assistantId="a9" />)
    expect(screen.getByText(zh.tasksEmpty)).toBeTruthy()
  })

  it('switches a task on in the chosen workspace, and off again', async () => {
    const { props } = faces(packagesState({ installed: [installedView()] }))
    render(<PackageTasks {...props} assistantId="a9" />)
    fireEvent.click(within(screen.getAllByRole('listitem')[0]!).getByRole('button', { name: '开启' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('开启「部门巡检」')
    expect(within(dialog).getByRole('option', { name: '默认工作区' })).toBeTruthy()
    fireEvent.change(within(dialog).getByRole('combobox', { name: '工作区' }), { target: { value: 'ws-2' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '开启' })) })
    expect(props.onTaskEnable).toHaveBeenCalledWith('a9', 'inspection', 'ws-2')
    expect(screen.queryByRole('dialog')).toBeNull()

    props.onTaskDisable.mockResolvedValueOnce('schedule busy')
    await act(async () => { fireEvent.click(within(screen.getAllByRole('listitem')[1]!).getByRole('button', { name: '关闭' })) })
    expect(props.onTaskDisable).toHaveBeenCalledWith('a9', 'report')
    expect(screen.getByRole('alert').textContent).toContain('操作失败：schedule busy')
  })

  it('cancels switching on, and closes the dialog from its close button', () => {
    const { props } = faces(packagesState({ installed: [installedView()] }))
    render(<PackageTasks {...props} assistantId="a9" />)
    const open = () => { fireEvent.click(within(screen.getAllByRole('listitem')[0]!).getByRole('button', { name: '开启' })) }
    open()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.dismiss }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(props.onTaskEnable).not.toHaveBeenCalled()
  })

  it('cannot switch on without a workspace', () => {
    const { props } = faces(packagesState({ installed: [installedView()] }))
    render(<PackageTasks {...props} useWorkspaces={bindSnapshotSelector(createSnapshotStore({ items: [] } as never))} assistantId="a9" />)
    fireEvent.click(within(screen.getAllByRole('listitem')[0]!).getByRole('button', { name: '开启' }))
    expect((within(screen.getByRole('dialog')).getAllByRole('button', { name: '开启' }).at(-1) as HTMLButtonElement).disabled).toBe(true)
  })

  it('updates from the detail page and reports kept files or a refusal', async () => {
    const { props } = faces(packagesState({ installed: [installedView({ updateVersion: '1.1.0' })] }))
    render(<PackageTasks {...props} assistantId="a9" />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新到 1.1.0' })) })
    expect(screen.getByRole('status').textContent).toContain('「运营日报助手」已更新到 1.1.0。')
    props.onPackageUpdate.mockResolvedValueOnce('nope' as never)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新到 1.1.0' })) })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：nope')
  })

  it('shows the update in progress', () => {
    const { props } = faces(packagesState({ installed: [installedView({ updateVersion: '1.1.0' })] }), 'a9')
    render(<PackageTasks {...props} assistantId="a9" />)
    expect(screen.getByRole('button', { name: '正在更新…' })).toBeTruthy()
  })
})

describe('the page with packages', () => {
  it('opens an installed assistant from the company section and shows its recommended tasks', async () => {
    const assistants: AssistantsState = {
      revision: 1, tenantId: 't-a', templates: [],
      assistants: [{ id: 'a9', name: '运营日报助手', description: '每天巡检与日报', avatar: { kind: 'preset', key: 'ocean' }, createdAt: '2026-10-13T00:00:00Z' }],
    }
    const store = createSnapshotStore<AssistantsSnapshot>({
      state: assistants, bound: null, staged: undefined, busy: false, failure: null, elsewhere: { asked: [], otherTenant: [] },
    })
    const sessions = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} } as never)
    const state = packagesState({ installed: [installedView()], packages: [{ ...packagesState().packages![0]!, installedAssistantId: 'a9' }] })
    const { props } = faces(state)
    const files = { 'IDENTITY.md': '# 身份\n', 'SOUL.md': '# 人格\n', 'USER.md': '# 用户\n', 'AGENTS.md': '# 方法\n' }
    render(
      <AssistantsPage
        {...props} useAssistants={bindSnapshotSelector(store)} useSessions={bindSnapshotSelector(sessions)}
        onOpenSession={vi.fn()} onPick={vi.fn(async () => {})} onChat={vi.fn(async () => {})} onDismiss={vi.fn()}
        onCreate={vi.fn(async () => undefined)} onLoadOptions={vi.fn(async () => ({ models: [], presets: [] }))} squareAvatar={vi.fn(async () => '')}
        onRead={vi.fn(async (): Promise<AssistantDetail | string> => ({ assistant: assistants.assistants[0]!, files }))}
        onUpdate={vi.fn(async () => undefined)} onDuplicate={vi.fn(async () => 'x')} onDelete={vi.fn(async () => undefined)} sessionCount={() => 0}
      />,
    )
    expect(screen.getByRole('region', { name: '企业智能体' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '查看' })) })
    expect(screen.getByRole('region', { name: '推荐定时任务' })).toBeTruthy()
  })
})

describe('packages source', () => {
  const deps = () => ({
    read: vi.fn(async () => ({ ok: true as const, value: packagesState() })),
    install: vi.fn(async (_id: string) => ({ ok: true as const, value: { assistantId: 'a9', version: '1.0.0', installedSkills: [] as string[], missingSkills: [] as string[], keptFiles: [] as string[], state: packagesState() } })),
    update: vi.fn(async (_id: string) => ({ ok: false as const, error: { message: 'not installed' } })),
    enableTask: vi.fn(async (_a: string, _t: string, _w: string) => ({ ok: true as const, value: packagesState() })),
    disableTask: vi.fn(async (_a: string, _t: string) => { throw new Error('connection lost') }),
    workspaces: createSnapshotStore({ items: [] } as never),
  })

  it('reads the state, and keeps the last one when a read fails or is refused', async () => {
    const d = deps()
    const source = createPackagesSource(d as never)
    await source.onPackagesRefresh()
    expect(source.hooks.packages.getSnapshot().state?.tenantId).toBe('t-a')
    d.read.mockResolvedValueOnce({ ok: false, error: { message: 'x' } } as never)
    await source.onPackagesRefresh()
    d.read.mockRejectedValueOnce(new Error('no remote'))
    await source.onPackagesRefresh()
    expect(source.hooks.packages.getSnapshot().state?.tenantId).toBe('t-a')
  })

  it('runs one action at a time, returns its outcome or refusal, and reads again after it', async () => {
    const d = deps()
    const source = createPackagesSource(d as never)
    let release!: () => void
    d.install.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ ok: true, value: { assistantId: 'a9', version: '1.0.0', installedSkills: ['x'], missingSkills: [], keptFiles: [], state: packagesState() } }) } }))
    const first = source.onPackageInstall('pkg-1')
    expect(source.hooks.packages.getSnapshot().running).toBe('pkg-1')
    expect(await source.onTaskEnable('a9', 'inspection', 'ws-1')).toBe(PACKAGES_BUSY)
    release()
    expect(await first).toEqual({ assistantId: 'a9', version: '1.0.0', installedSkills: ['x'], missingSkills: [], keptFiles: [] })
    expect(source.hooks.packages.getSnapshot()).toMatchObject({ running: null, state: { tenantId: 't-a' } })
    // The returned state is shown as is; only a refusal reads the state again.
    expect(d.read).not.toHaveBeenCalled()
    expect(await source.onPackageUpdate('a9')).toBe('not installed')
    expect(d.read).toHaveBeenCalledTimes(1)
    expect(await source.onTaskEnable('a9', 'inspection', 'ws-1')).toBeUndefined()
    expect(await source.onTaskDisable('a9', 'inspection')).toBe('connection lost')
    d.disableTask.mockRejectedValueOnce('plain refusal')
    expect(await source.onTaskDisable('a9', 'inspection')).toBe('plain refusal')
    d.disableTask.mockResolvedValueOnce({ ok: true, value: packagesState() } as never)
    expect(await source.onTaskDisable('a9', 'inspection')).toBeUndefined()
  })
})
