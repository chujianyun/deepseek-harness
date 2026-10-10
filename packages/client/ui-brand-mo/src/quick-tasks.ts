/** Quick tasks the MO new-session page can offer; each id has its title, description, and prompt in the browser dictionary. */
export const QUICK_TASK_IDS = ['multi-publish', 'business-report', 'product-research', 'asset-organize'] as const

/** One offered quick task. */
export type QuickTaskId = typeof QUICK_TASK_IDS[number]

/** Settings namespace (the Loader entry id) the browser reads `quickTasks` from. */
export const BRAND_SETTINGS_NAMESPACE = 'ui-brand-mo'
