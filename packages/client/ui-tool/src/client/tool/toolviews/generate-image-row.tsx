// generate_image toolview registrant: the ordinary Tool row with the prompt as
// its summary. The generated images show under the Turn's answer (see
// `tool/generated/`), since this row sits inside the Turn's collapsed process;
// the row's expanded body is the result's own text, never the flattened image
// block, which would print the attachment object.

import type { Context } from '@deepseek-ai/cordis'
import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import { ToolRow, type ToolRowProps } from '../components/ToolRow.tsx'
import { toolRowModel, type ToolCallBlock } from '../models/tool-call-model.ts'

/** Props of {@link GenerateImageRow}. */
export type GenerateImageRowProps = ToolCallViewProps & { t: ToolRowProps['t'] }

/**
 * The text a settled result carries, or null while running.
 * @param block - running or settled Tool block.
 * @returns the joined text blocks, or null.
 */
export function generatedImageText(block: ToolCallBlock): string | null {
  if (!('kind' in block)) return null
  return block.content
    .flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
    .join('\n')
}

/**
 * generate_image row: the Tool row with the result's own text as its body.
 * @param props - toolview owner props and copy.
 * @returns the row.
 */
export function GenerateImageRow(props: GenerateImageRowProps) {
  const { toolName, block, cwd, home, inspect, useDisclosure, t } = props
  const model = toolRowModel(toolName, block, cwd, home)
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconSparkleRegular size={14} />}
      title={t(model.titleKey)}
      summary={model.summary}
      bodyRaw={model.bodyRaw}
      output={generatedImageText(block) ?? model.output}
      errorSummary={model.errorSummary}
      state={model.state}
      inspect={inspect}
    />
  )
}

/** The generate_image row as a registrant plugin. */
export const generateImageToolview = {
  name: 'generate-image-toolview',
  inject: ['slots'],
  /**
   * Register the generate_image row into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'generate_image', locale: NS }, GenerateImageRow))
  },
}
