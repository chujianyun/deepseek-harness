/**
 * The field rules of a Tmall category's publish form, read live with the store's merchant account
 * from the publish page Tmall's AI publishing opens (`publish.htm?catId=…&newRouter=1&fromAIPublish=true`).
 * The page carries its whole form as `window.Json2`: components with name, control, required flag,
 * options, and the rules that show or hide them. The page reflects the store's authorizations and
 * Tmall's current requirements, such as the medical-device declarations.
 */

import { EXIT, SkillError } from './errors.ts'
import { waitSignedIn } from './publish-category.ts'
import type { Page } from './page.ts'

/**
 * The publish page of a category, as Tmall's AI publishing opens it.
 * @param catId - the category id.
 * @returns the address.
 */
export function publishUrl(catId: string): string {
  return `https://sell.publish.tmall.com/tmall/publish.htm?catId=${encodeURIComponent(catId)}&newRouter=1&fromAIPublish=true`
}

/** One choice of a field. */
export interface FieldOption {
  readonly value: string | number
  readonly text: string
}

/** One field of the publish form. */
export interface FieldRule {
  /** The form value's name, such as `title` or a category property's `p-8484762`. */
  readonly key: string
  readonly label: string
  /** The page's control, such as `select`, `combobox`, `checkbox`, or `newSku`. */
  readonly uiType: string
  readonly required: boolean
  /** The choices, for a field that offers them. */
  readonly options?: readonly FieldOption[]
  /** For a category property, the component it belongs to: `keyProp`, `bindProp`, or `itemProp`. */
  readonly propGroup?: string
  /** The value cannot be changed, such as the store's only authorized brand. */
  readonly readonly?: boolean
  /** A value outside the options is accepted. */
  readonly allowsCustom?: boolean
  /** Shown when the page opens; a hidden field appears only when one of its conditions holds. */
  readonly visible: boolean
  /** The page's conditions that show, hide, or require the field, in the page's own expression syntax. */
  readonly conditions?: readonly string[]
  /** A required single-option checkbox the store ticks to declare something, such as the medical-device personal-use confirmation. */
  readonly declaration?: boolean
}

/** A category's publish form. */
export interface PublishRules {
  readonly catId: string
  /** The page's own category line, such as 「计生用品>>避孕套」; empty when the page does not show it. */
  readonly categoryPath: string
  readonly fields: readonly FieldRule[]
}

/** A component of the page's form. */
interface Component {
  readonly type?: string
  readonly props?: {
    readonly name?: string
    readonly label?: string
    readonly uiType?: string
    readonly required?: boolean
    readonly readonly?: boolean
    readonly visible?: boolean
    readonly dataSource?: unknown
    readonly descriptions?: { readonly data?: { readonly label?: string } }
  }
}

/** A category property inside a `catProp` component. */
interface CatProp {
  readonly name: string
  readonly label?: string
  readonly uiType?: string
  readonly required?: boolean
  readonly readonly?: boolean
  readonly dataSource?: readonly { readonly value: string | number; readonly text: string }[]
}

/** The form the page carries. */
export interface PageForm {
  readonly components: Readonly<Record<string, Component>>
  readonly models?: { readonly catpath?: { readonly value?: string } }
  readonly rules?: unknown
}

/** Component types that lay the page out or talk to the user rather than hold a value the seller fills. */
const NOT_FIELDS: ReadonlySet<string> = new Set([
  'struct', 'block', 'button', 'hidden', 'flexBox', 'fixContainer', 'floatBottom', 'nav', 'globalMessage', 'feedback', 'feedbackDialog',
  'text', 'richText', 'info', 'tmErrorBoard', 'tmSkuCheck', 'actionMessage', 'violationWarning',
])

/** Controls whose choices are not a closed list. */
const OPEN_CHOICE: ReadonlySet<string> = new Set(['combobox', 'sequentialCombobox', 'newColorSelect'])

/**
 * The choices a `dataSource` lists, when it is a list of value/text pairs.
 * @param source - the component's data source.
 * @returns the choices, or undefined.
 */
function optionsOf(source: unknown): FieldOption[] | undefined {
  if (!Array.isArray(source)) return undefined
  const options = source.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return []
    const { value, text } = entry as { value?: unknown; text?: unknown }
    return (typeof value === 'string' || typeof value === 'number') && typeof text === 'string' ? [{ value, text }] : []
  })
  return options.length === 0 ? undefined : options
}

/**
 * The page's conditions that change each field, from its rules.
 * @param rules - the form's rules.
 * @returns field name → condition expressions.
 */
export function conditionsByField(rules: unknown): Map<string, string[]> {
  const byField = new Map<string, string[]>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (node === null || typeof node !== 'object') return
    const { condition, target } = node as { condition?: unknown; target?: unknown }
    if (typeof condition === 'string' && target !== null && typeof target === 'object') {
      for (const field of Object.keys(target)) {
        const list = byField.get(field) ?? []
        if (!list.includes(condition)) list.push(condition)
        byField.set(field, list)
      }
    }
    for (const child of Object.values(node)) visit(child)
  }
  visit(rules)
  return byField
}

/**
 * Turn the page's form into field rules.
 * @param form - `window.Json2` of the publish page.
 * @param catId - the category the page is for.
 * @returns the category line and every field the seller fills, category properties expanded.
 */
export function parseRules(form: PageForm, catId: string): PublishRules {
  const conditions = conditionsByField(form.rules)
  const withConditions = (key: string): { conditions?: string[] } => {
    const list = conditions.get(key)
    return list === undefined ? {} : { conditions: list }
  }
  const fields: FieldRule[] = []
  for (const component of Object.values(form.components)) {
    const props = component.props
    if (props?.name === undefined || component.type === undefined || NOT_FIELDS.has(component.type)) continue
    if (component.type === 'catProp') {
      const props2 = Array.isArray(props.dataSource) ? props.dataSource as readonly CatProp[] : []
      for (const prop of props2) {
        const uiType = prop.uiType ?? 'input'
        const options = optionsOf(prop.dataSource)
        fields.push({
          key: prop.name, label: prop.label || prop.name, uiType, required: prop.required === true, propGroup: props.name,
          ...options === undefined ? {} : { options },
          ...prop.readonly === true ? { readonly: true } : {},
          ...OPEN_CHOICE.has(uiType) ? { allowsCustom: true } : {},
          visible: props.visible !== false, ...withConditions(prop.name),
        })
      }
      continue
    }
    const uiType = props.uiType ?? component.type
    const options = optionsOf(props.dataSource)
    const required = props.required === true
    fields.push({
      key: props.name, label: props.label || props.descriptions?.data?.label || props.name, uiType, required,
      ...options === undefined ? {} : { options },
      ...props.readonly === true ? { readonly: true } : {},
      ...OPEN_CHOICE.has(uiType) ? { allowsCustom: true } : {},
      visible: props.visible !== false, ...withConditions(props.name),
      ...uiType === 'checkbox' && required && options?.length === 1 ? { declaration: true } : {},
    })
  }
  return { catId, categoryPath: (form.models?.catpath?.value ?? '').replace(/^当前类目：/u, ''), fields }
}

/** What the publish page says when Tmall refuses the category to the store. */
const REFUSED = /类目为空或不存在|没有权限|未授权/u

/** Reads the page's form, or says why it cannot. */
const READ_FORM = `(() => {
  const form = window.Json2
  if (form && form.components) return { form: { components: form.components, models: { catpath: form.models && form.models.catpath }, rules: form.rules } }
  const text = document.body ? document.body.innerText.slice(0, 300) : ''
  return { error: text }
})()`

/**
 * Open a category's publish page and read its field rules.
 * @param page - a tab of the merchant account.
 * @param catId - the category.
 * @returns the rules.
 * @throws SkillError signed-out on a sign-in page; usage when Tmall refuses the category; failed when the
 *   page carries no form or a form without fields, such as after Tmall changes the page.
 */
export async function readRules(page: Page, catId: string): Promise<PublishRules> {
  await page.goto(publishUrl(catId))
  let answer: { form?: PageForm; error?: string } = {}
  await waitSignedIn(page, async () => {
    answer = await page.evaluate<{ form?: PageForm; error?: string }>(READ_FORM)
    return answer.form !== undefined || REFUSED.test(answer.error ?? '')
  }, 20_000)
  const said = (answer.error ?? '').replace(/\s+/gu, ' ').trim()
  if (REFUSED.test(said)) throw new SkillError(`天猫不让这家店在类目 ${catId} 发布：${said.slice(0, 120)}`, EXIT.usage)
  const rules = answer.form === undefined ? undefined : parseRules(answer.form, catId)
  if (rules === undefined || rules.fields.length === 0) {
    throw new SkillError(`天猫发布页没有给出表单字段（类目 ${catId}），页面可能已改版。${said === '' ? '' : `页面显示：${said.slice(0, 120)}`}`, EXIT.failed)
  }
  return rules
}
