import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import * as HostPlugin from '../src/index.ts'
import { Config, QUICK_TASK_IDS, apply } from '../src/index.ts'

it('projects an ordered quick-task list and the template a card picks, defaulting to none and accepting only known tasks', async () => {
  const ctx = new Context()
  const configuration = await liveConfig(ctx, { Config, apply })
  expect(plainConfig(configuration.fiber.config)).toEqual({ quickTasks: [], quickTaskAssistant: '', defaultSessionGrouping: '', sessionsPerGroup: 5 })
  await configuration.update({
    quickTasks: ['asset-organize', 'multi-publish'], quickTaskAssistant: 'ecommerce', defaultSessionGrouping: 'assistant', sessionsPerGroup: 8,
  })
  expect(plainConfig(configuration.fiber.config)).toEqual({
    quickTasks: ['asset-organize', 'multi-publish'], quickTaskAssistant: 'ecommerce', defaultSessionGrouping: 'assistant', sessionsPerGroup: 8,
  })
  for (const bad of [0, -1, 2.5]) await expect(configuration.update({ sessionsPerGroup: bad })).rejects.toThrow()
  await expect(configuration.update({ quickTasks: ['order-lunch'] })).rejects.toThrow()
  expect(QUICK_TASK_IDS).toEqual(['multi-publish', 'business-report', 'product-research', 'asset-organize'])
  await configuration.fiber.dispose()
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
