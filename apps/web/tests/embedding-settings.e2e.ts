// Settings → Embedding models over the real `embedding` and `llm-pi-ai` rows: at startup the
// local model downloads from a loopback mirror (a tiny stand-in model and runtime) and reports
// its vector size; an API embedding model is added on a configured OpenAI-compatible route,
// measured with one request, listed, and removed.
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-embedding'
import type {} from '@deepseek-ai/dsh-hub-account'
import { buildFixtures, startMirror } from '../../../packages/llm/embedding/tests/fixtures.ts'
import { startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './embedding-settings.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))

/** A mock OpenAI-compatible `/v1/embeddings` answering 3-dimensional vectors. */
async function startEmbeddingsEndpoint() {
  const models: string[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; input: string[] }
      models.push(body.model)
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseURL: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/v1`,
    models,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
}

it('downloads the local embedding model at startup, and adds and removes an API embedding model', async () => {
  const fixtures = await buildFixtures()
  const mirror = await startMirror(fixtures.served)
  const api = await startEmbeddingsEndpoint()
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_EMBEDDING_API: api.baseURL })
  // The embedding row's sources live in the home profile patch, the layer Settings writes to.
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-embedding-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{
    id: 'embedding',
    config: {
      modelMirrors: [`${mirror.origin}/models/{repo}/{file}`], npmRegistries: [`${mirror.origin}/npm`],
      localModel: fixtures.model, runtime: fixtures.runtime,
    },
  }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    // The Host downloaded the model in the background while booting.
    await expect.poll(async () => (await scaffold.ctx.embedding.getState()).local.status, { timeout: 15_000 }).toBe('installed')
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('button', { name: '嵌入模型', exact: true }).click()
    const section = settings.getByRole('region', { name: '嵌入模型' })
    await section.getByText('已安装').waitFor({ timeout: 10_000 })
    await expect.poll(() => section.textContent()).toContain('Tiny')
    await expect.poll(() => section.textContent()).toContain('4 维')
    expect(mirror.requests.map(request => request.path)).toContain('/models/acme/tiny/onnx/model.onnx')

    // An API embedding model on the configured gateway: one probe measures its size.
    await section.getByRole('combobox', { name: '提供商' }).selectOption('acme-gateway')
    await section.getByRole('textbox', { name: '模型 ID' }).fill('bge-m3')
    await section.getByRole('button', { name: '添加', exact: true }).click()
    await section.getByText('Acme 网关 · 3 维').waitFor({ timeout: 10_000 })
    expect(api.models).toEqual(['bge-m3'])
    expect(await scaffold.ctx.embedding.embed('acme-gateway/bge-m3', ['x'])).toEqual([[0.1, 0.2, 0.3]])
    await section.getByRole('button', { name: '删除 bge-m3' }).click()
    await section.getByText('还没有添加 API 嵌入模型。').waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-embedding-settings')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await api.close()
    await mirror.close()
    await center.close()
    await fixtures.cleanup()
    await rm(harnessHome, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    Reflect.deleteProperty(process.env, 'DSH_E2E_EMBEDDING_API')
  }
})
