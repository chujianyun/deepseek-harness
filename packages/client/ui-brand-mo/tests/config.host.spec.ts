import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import * as HostPlugin from '../src/index.ts'
import { Config, QUICK_TASK_IDS, apply } from '../src/index.ts'

it('projects an ordered quick-task list that defaults to none and accepts only known tasks', async () => {
  const ctx = new Context()
  const configuration = await liveConfig(ctx, { Config, apply })
  expect(plainConfig(configuration.fiber.config)).toEqual({ quickTasks: [] })
  await configuration.update({ quickTasks: ['asset-organize', 'multi-publish'] })
  expect(plainConfig(configuration.fiber.config)).toEqual({ quickTasks: ['asset-organize', 'multi-publish'] })
  await expect(configuration.update({ quickTasks: ['order-lunch'] })).rejects.toThrow()
  expect(QUICK_TASK_IDS).toEqual(['multi-publish', 'business-report', 'product-research', 'asset-organize'])
  await configuration.fiber.dispose()
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
