/** The sources a completed Turn cited from knowledge bases, below its answer. */
import { useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { FileTypeIcon, LinkIconRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { KnowledgeCitation } from '@deepseek-ai/dsh-knowledge-selection/client'
import { turnSources, type KnowledgeCitations } from './citations.ts'
import css from './KnowledgePage.module.css'

/** Turn-keyed citation results and how to open a source. */
export interface KnowledgeCitationsInjected {
  keyedHooks: {
    /** One Turn's `knowledge_search` results, in call order. */
    citations: (turn: string) => ObservableSnapshot<readonly KnowledgeCitations[]>
  }
  /** Open a file or note copy on this machine; whether it opened. */
  openItem: (citation: KnowledgeCitation) => Promise<boolean>
  /** Open a page's address in the browser. */
  openUrl: (url: string) => void
}

/**
 * Render the sources a Turn cited, each item once with its best passage.
 * @param props - the Turn, its citations, localized copy, and openers.
 * @returns the source cards, or null for a Turn that searched nothing.
 */
export function KnowledgeCitationsCard({ turn, useCitations, openItem, openUrl, t }: PropsRuntime<'conversation.chat.turnTail'> & InjectFace<KnowledgeCitationsInjected> & PropsLocale<'knowledge'>) {
  const results = useCitations(String(turn.turn))
  const [failure, setFailure] = useState<string | null>(null)
  const sources = results === undefined ? [] : turnSources(results)
  if (sources.length === 0) return null
  const open = async (source: KnowledgeCitation): Promise<void> => {
    setFailure(null)
    if (source.kind === 'url' && source.source !== undefined) { openUrl(source.source); return }
    if (!await openItem(source)) setFailure(t('citations.openFailed', { name: source.item }))
  }
  return (
    <section className={css.citations} aria-label={t('citations.title')}>
      <h4 className={css.citationsTitle}>{t('citations.title')}</h4>
      <ol className={css.citationList}>
        {sources.map(source => (
          <li key={`${source.knowledgeBaseId}/${source.itemId}`}>
            <button type="button" className={css.citation} onClick={() => { void open(source) }}
              aria-label={t(source.kind === 'url' ? 'citations.openUrl' : 'citations.openItem', { name: source.item })}>
              <span className={css.citationIcon}>
                {source.kind === 'url' ? <LinkIconRegular kind="url" href={source.source} size={16} /> : <FileTypeIcon size={16} path={source.kind === 'note' ? `${source.item}.md` : source.item} />}
              </span>
              <span className={css.citationBody}>
                <span className={css.citationName}>{source.item}</span>
                <span className={css.citationMeta}>{t('citations.meta', { base: source.knowledgeBase, chunk: String(source.chunk) })}</span>
                <span className={css.citationSnippet}>{source.snippet}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {failure !== null && <p className={css.fieldError} role="alert">{failure}</p>}
    </section>
  )
}
