/** Permanent Session deletion through the shipped Web composition: storage, registry, list, and search. */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession } from './scaffold.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

/** Every path under `root` whose final segment names the Session. */
async function pathsNaming(root: string, sessionId: SessionId): Promise<string[]> {
  const entries = await readdir(root, { recursive: true })
  return entries.filter(entry => entry.split(/[\\/]/u).some(segment => segment.includes(sessionId)))
}

it('deletes a loaded Session from storage, the Workspace registry, the list, and search, and leaves the others', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const { ctx } = scaffold
    const fixture = await readFile(SEED, 'utf8')
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const gone = await seedSession(scaffold, fixture, 'session-delete-gone')
    const kept = await seedSession(scaffold, fixture, 'session-delete-kept')
    for (const id of [gone, kept]) await workspace.attachSession(id)
    await ctx.workspaceRegistry.pinSession(gone)
    await ctx.schedule.create(gone, { prompt: 'check later', after_seconds: 3_600, title: 'Check later' })
    // Load the Session, as an open conversation would: its Agent holds the log's writer.
    const resolved = await ctx.sessionController.resolveAgent(gone)
    expect('agent' in resolved).toBe(true)
    expect((await pathsNaming(scaffold.persistenceRoot, gone)).length).toBeGreaterThan(0)
    const listed = async () => (await ctx.sessionController.list({}, new AbortController().signal)).items.map(item => item.sessionId)
    expect(await listed()).toEqual(expect.arrayContaining([gone, kept]))

    expect(await ctx.sessionController.delete({ sessionId: gone })).toEqual({ deletedSessionIds: [gone] })

    // Nothing on disk names the Session any more: its log directory and its projection checkpoint are gone.
    expect(await pathsNaming(scaffold.persistenceRoot, gone)).toEqual([])
    await expect.poll(() => pathsNaming(scaffold.harnessHome, gone)).toEqual([])
    expect(await ctx.sessionPersistence.stat(gone)).toBeUndefined()
    expect(ctx.sessions.get(gone)).toBeUndefined()
    expect(ctx.agents.get(gone)).toBeUndefined()
    const afterwards = await listed()
    expect(afterwards).toContain(kept)
    expect(afterwards).not.toContain(gone)
    expect(workspace.sessionIds).toEqual([kept])
    expect(ctx.workspaceRegistry.pinnedSessionIds).toEqual([])
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([])
    await expect.poll(async () => (await ctx.schedule.catalog()).map(entry => entry.sessionId)).toEqual([])
    // The other Session is untouched and still opens.
    expect((await pathsNaming(scaffold.persistenceRoot, kept)).length).toBeGreaterThan(0)
    expect('agent' in await ctx.sessionController.resolveAgent(kept)).toBe(true)
    // A second delete finds nothing.
    await expect(ctx.sessionController.delete({ sessionId: gone })).rejects.toMatchObject({ code: 'session/not-found' })
  } finally {
    await scaffold.close()
  }
}, 90_000)
