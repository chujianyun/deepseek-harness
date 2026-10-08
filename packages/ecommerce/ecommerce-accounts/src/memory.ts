/**
 * A company's publishing memory: what the user confirmed once while publishing and wants applied next
 * time. Store information (brand, registration numbers, origin, shipping …) is kept per store; a product
 * line remembers its category; table headers remember the SKU field they hold; declarations remember
 * when the store confirmed them, per store and category. The memory lives with the company's accounts
 * at `<dshHome>/ecommerce/<tenantId>/publish-memory.json`, so one company never sees another's.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

/** A field value: one text, or several for a multi-choice field. */
export type MemoryValue = string | readonly string[]

/** One store's information. */
export interface StoreMemory {
  /** Field label → value, such as 产地 → 大陆. */
  readonly values: Readonly<Record<string, MemoryValue>>
  readonly updatedAt: string
}

/** The category a product line is published in. */
export interface CategoryMemory {
  readonly platform: string
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
  /** Product line → its category. */
  readonly categories: Readonly<Record<string, CategoryMemory>>
  /** Table header → SKU field, such as 到手价 → price. */
  readonly columns: Readonly<Record<string, { readonly field: string; readonly updatedAt: string }>>
  /** Store name → category id → declaration key → its confirmation. */
  readonly declarations: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, DeclarationMemory>>>>>>
}

/** The memory of a company that remembered nothing yet. */
export const EMPTY_MEMORY: PublishMemory = { stores: {}, categories: {}, columns: {}, declarations: {} }

/** The SKU fields a header can be remembered for, as the product-draft skill names them. */
export const SKU_FIELDS = ['index', 'name', 'code', 'count', 'price', 'stock', 'unitPrice', 'ignore'] as const

const text = z.string().trim().min(1).max(500)
const value = z.union([text, z.array(text).min(1).max(50)])

/** What `dsh-ecommerce remember` accepts: any of the four parts; a null value forgets that entry. */
export const MemoryUpdate = z.object({
  store: z.object({ name: text, values: z.record(text, value.nullable()) }).strict().optional(),
  category: z.object({ line: text, platform: text, catId: z.string().regex(/^\d+$/u), categoryPath: z.string().max(500).default('') }).strict().optional(),
  columns: z.record(text, z.enum(SKU_FIELDS).nullable()).optional(),
  declarations: z.object({
    store: text, catId: z.string().regex(/^\d+$/u), confirmed: z.array(z.object({ key: text, text: z.string().max(2000) }).strict()).min(1),
  }).strict().optional(),
}).strict().refine(update => Object.values(update).some(part => part !== undefined), 'nothing to remember')

/** A checked update. */
export type MemoryUpdate = z.infer<typeof MemoryUpdate>

/**
 * Apply an update: values are set, a null value forgets its entry, and everything touched gets the time.
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
  const categories = { ...memory.categories }
  if (update.category !== undefined) {
    const { line, ...category } = update.category
    categories[line] = { ...category, updatedAt: now }
  }
  const columns = { ...memory.columns }
  for (const [header, field] of Object.entries(update.columns ?? {})) {
    if (field === null) Reflect.deleteProperty(columns, header)
    else columns[header] = { field, updatedAt: now }
  }
  const declarations = { ...memory.declarations }
  if (update.declarations !== undefined) {
    const { store, catId, confirmed } = update.declarations
    const byCategory = { ...declarations[store] }
    const added = Object.fromEntries(confirmed.map(item => [item.key, { text: item.text, confirmedAt: now }]))
    byCategory[catId] = { ...byCategory[catId], ...added }
    declarations[store] = byCategory
  }
  return { stores, categories, columns, declarations }
}

/**
 * Read a company's memory; a missing or damaged file reads as empty.
 * @param path - the file.
 * @returns the memory.
 */
export async function readMemory(path: string): Promise<PublishMemory> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PublishMemory>
    return { ...EMPTY_MEMORY, ...parsed }
  } catch {
    // A company that remembered nothing has no file; a damaged one starts over rather than block publishing.
    return EMPTY_MEMORY
  }
}

/**
 * Write a company's memory, replacing the file whole.
 * @param path - the file.
 * @param memory - the memory.
 */
export async function writeMemory(path: string, memory: PublishMemory): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, `${JSON.stringify(memory, null, 2)}\n`)
  await rename(`${path}.tmp`, path)
}
