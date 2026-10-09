/**
 * A company's publishing memory: what the user confirmed once while publishing and wants applied next
 * time. Store information (brand, registration numbers, origin, shipping …) is kept per store; a product
 * line remembers its category on each platform; table headers remember the SKU field they hold; declarations remember
 * when the store confirmed them, per store and category. The memory lives with the company's accounts
 * at `<dshHome>/ecommerce/<tenantId>/publish-memory.json`, so one company never sees another's.
 */

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { ECOMMERCE_PLATFORMS } from './platforms.ts'

/** A field value: one text, or several for a multi-choice field. */
export type MemoryValue = string | readonly string[]

/** One store's information. */
export interface StoreMemory {
  /** Field label → value, such as 产地 → 大陆. */
  readonly values: Readonly<Record<string, MemoryValue>>
  readonly updatedAt: string
}

/** The category a product line is published in on one platform. */
export interface CategoryMemory {
  readonly catId: string
  readonly categoryPath: string
  readonly updatedAt: string
}

/** A declaration the store confirmed. */
export interface DeclarationMemory {
  /** The declaration's text as the platform shows it. */
  readonly text: string
  readonly confirmedAt: string
}

/** A company's publishing memory. */
export interface PublishMemory {
  /** Store name → its information. */
  readonly stores: Readonly<Record<string, StoreMemory>>
  /**
   * Product line → platform → its category there. A remember writes only the platforms of
   * {@link ECOMMERCE_PLATFORMS}; a file may hold other platform names, such as one saved before
   * categories were kept per platform, which are kept as they are.
   */
  readonly categories: Readonly<Record<string, Readonly<Partial<Record<string, CategoryMemory>>>>>
  /** Table header → SKU field, such as 到手价 → price. */
  readonly columns: Readonly<Record<string, { readonly field: string; readonly updatedAt: string }>>
  /** Store name → category id → declaration key → its confirmation. */
  readonly declarations: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, DeclarationMemory>>>>>>
}

/** The memory of a company that remembered nothing yet. */
export const EMPTY_MEMORY: PublishMemory = { stores: {}, categories: {}, columns: {}, declarations: {} }

/** The SKU fields a header can be remembered for, as the product-draft skill names them. */
export const SKU_FIELDS = ['index', 'name', 'code', 'count', 'price', 'stock', 'unitPrice', 'ignore'] as const

/** Names that would reach an object's prototype instead of being a key. */
const RESERVED: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const text = z.string().trim().min(1).max(500)
const key = text.refine(name => !RESERVED.has(name), 'this name cannot be used')
const value = z.union([text, z.array(text).min(1).max(50)])
const catId = z.string().regex(/^\d+$/u)

/**
 * What `dsh-ecommerce remember` accepts: any of these parts. In `store.values` and `columns` a null value
 * forgets that entry; `forget` removes remembered categories — a product line on every platform, or
 * `{line, platform}` on one — and declarations.
 */
export const MemoryUpdate = z.object({
  store: z.object({ name: key, values: z.record(key, value.nullable()) }).strict().optional(),
  category: z.object({ line: key, platform: z.enum(ECOMMERCE_PLATFORMS), catId, categoryPath: z.string().max(500).default('') }).strict().optional(),
  columns: z.record(key, z.enum(SKU_FIELDS).nullable()).optional(),
  declarations: z.object({
    store: key, catId, confirmed: z.array(z.object({ key, text: z.string().max(2000) }).strict()).min(1),
  }).strict().optional(),
  forget: z.object({
    categories: z.array(z.union([key, z.object({ line: key, platform: z.enum(ECOMMERCE_PLATFORMS) }).strict()])).min(1).optional(),
    /** Declarations of a store and category; without keys, all of them. */
    declarations: z.array(z.object({ store: key, catId, keys: z.array(key).min(1).optional() }).strict()).min(1).optional(),
  }).strict().optional(),
}).strict().refine(update => Object.values(update).some(part => part !== undefined), 'nothing to remember')

/** A checked update. */
export type MemoryUpdate = z.infer<typeof MemoryUpdate>

/** The memory file, as written. */
const byName = <T extends z.ZodType>(entry: T) => z.record(z.string(), entry)
const category = z.object({ catId: z.string(), categoryPath: z.string(), updatedAt: z.string() })
/**
 * A product line's categories by platform; a line written before they were kept per platform holds one
 * with its platform, read as that platform's whatever name it was saved under.
 */
const lineCategories = z.union([
  category.extend({ platform: z.string().min(1) }).strict().transform(({ platform, ...entry }) => ({ [platform]: entry })),
  z.record(z.string(), category),
])
const MemoryFile = z.object({
  stores: byName(z.object({ values: byName(value), updatedAt: z.string() })).default({}),
  categories: byName(lineCategories).default({}),
  columns: byName(z.object({ field: z.string(), updatedAt: z.string() })).default({}),
  declarations: byName(byName(byName(z.object({ text: z.string(), confirmedAt: z.string() })))).default({}),
})

/**
 * Apply an update: values are set, a null value or `forget` removes entries, and everything touched gets the time.
 * @param memory - the memory now.
 * @param update - what to remember or forget.
 * @param now - the time, ISO.
 * @returns the new memory.
 */
export function applyUpdate(memory: PublishMemory, update: MemoryUpdate, now: string): PublishMemory {
  const stores = { ...memory.stores }
  if (update.store !== undefined) {
    const values: Record<string, MemoryValue> = { ...stores[update.store.name]?.values }
    for (const [label, entry] of Object.entries(update.store.values)) {
      if (entry === null) Reflect.deleteProperty(values, label)
      else values[label] = entry
    }
    if (Object.keys(values).length === 0) Reflect.deleteProperty(stores, update.store.name)
    else stores[update.store.name] = { values, updatedAt: now }
  }
  const categories: Record<string, Partial<Record<string, CategoryMemory>>> = {}
  for (const [line, byPlatform] of Object.entries(memory.categories)) categories[line] = { ...byPlatform }
  // Forgetting comes first, so a remember that forgets a line and sets one of its platforms keeps the new one.
  for (const forgotten of update.forget?.categories ?? []) {
    if (typeof forgotten === 'string') { Reflect.deleteProperty(categories, forgotten); continue }
    const byPlatform = categories[forgotten.line]
    if (byPlatform === undefined) continue
    Reflect.deleteProperty(byPlatform, forgotten.platform)
    if (Object.keys(byPlatform).length === 0) Reflect.deleteProperty(categories, forgotten.line)
  }
  if (update.category !== undefined) {
    const { line, platform, ...entry } = update.category
    categories[line] = { ...categories[line], [platform]: { ...entry, updatedAt: now } }
  }
  const columns = { ...memory.columns }
  for (const [header, field] of Object.entries(update.columns ?? {})) {
    if (field === null) Reflect.deleteProperty(columns, header)
    else columns[header] = { field, updatedAt: now }
  }
  const declarations: Record<string, Record<string, Record<string, DeclarationMemory>>> = {}
  for (const [store, byCategory] of Object.entries(memory.declarations)) declarations[store] = { ...byCategory }
  if (update.declarations !== undefined) {
    const { store, catId: category, confirmed } = update.declarations
    const added = Object.fromEntries(confirmed.map(item => [item.key, { text: item.text, confirmedAt: now }]))
    declarations[store] = { ...declarations[store], [category]: { ...declarations[store]?.[category], ...added } }
  }
  for (const { store, catId: category, keys } of update.forget?.declarations ?? []) {
    const byCategory = declarations[store]
    if (byCategory?.[category] === undefined) continue
    const kept = keys === undefined ? {} : Object.fromEntries(Object.entries(byCategory[category]).filter(([name]) => !keys.includes(name)))
    if (Object.keys(kept).length === 0) Reflect.deleteProperty(byCategory, category)
    else byCategory[category] = kept
    if (Object.keys(byCategory).length === 0) Reflect.deleteProperty(declarations, store)
  }
  return { stores, categories, columns, declarations }
}

/** The memory file exists but cannot be read as a memory; it is left as it is. */
export class DamagedMemory extends Error {}

/**
 * Read a company's memory; a missing file reads as empty.
 * @param path - the file.
 * @returns the memory.
 * @throws DamagedMemory when the file is not a memory, so nothing overwrites what it held.
 */
export async function readMemory(path: string): Promise<PublishMemory> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    // A company that remembered nothing has no file yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_MEMORY
    throw new DamagedMemory((error as Error).message)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new DamagedMemory((error as Error).message)
  }
  const parsed = MemoryFile.safeParse(json)
  if (!parsed.success) throw new DamagedMemory(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  return parsed.data
}
