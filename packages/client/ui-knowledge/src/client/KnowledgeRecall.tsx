/**
 * Recall test: search a knowledge base under its retrieval settings and show the chunks found,
 * where they come from, and their scores. Nothing enters a session.
 */

import { useState } from 'react'
import type { KnowledgeBaseView } from '@deepseek-ai/dsh-knowledge-base/types'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { failureText, type KnowledgePageProps } from './shared.ts'
import css from './KnowledgePage.module.css'

/**
 * Render the recall test of the selected knowledge base.
 * @param props - the page props and the knowledge base.
 * @returns the query box and the hits.
 */
export function KnowledgeRecallPanel(props: KnowledgePageProps & { base: KnowledgeBaseView }) {
  const { t, base, useKnowledge, onRecall } = props
  const recall = useKnowledge(snapshot => snapshot.recall)
  const [query, setQuery] = useState('')
  const mine = recall?.baseId === base.id ? recall : null
  const running = mine?.running === true
  const submit = (): void => { if (query.trim() !== '' && !running) void onRecall(base.id, query.trim()) }
  const { documentCount, threshold } = base.settings
  const result = mine?.result ?? null
  return (
    <div className={css.recall}>
      <form className={css.recallForm} onSubmit={(event) => { event.preventDefault(); submit() }}>
        <Input value={query} placeholder={t('recall.placeholder')} aria-label={t('recall.placeholder')} onChange={(event) => { setQuery(event.target.value) }} />
        <Button variant="primary" type="submit" disabled={query.trim() === '' || running}>{t('recall.submit')}</Button>
      </form>
      <p className={css.muted}>{t('recall.settings', { count: String(documentCount), threshold: threshold.toFixed(2) })}</p>
      {running && <p className={css.muted} role="status">{t('recall.searching')}</p>}
      {mine !== null && mine.failure !== null && <p className={css.alert} role="alert">{failureText(t, mine.failure)}</p>}
      {result === null && mine === null && (
        <div className={css.recallEmpty}>
          <p className={css.recallEmptyTitle}>{t('recall.emptyTitle')}</p>
          <p className={css.muted}>{t('recall.emptyDescription')}</p>
        </div>
      )}
      {result !== null && (
        <>
          <p className={css.muted} role="status">
            {t('recall.summary', {
              count: String(result.hits.length), duration: String(result.durationMs),
              top: result.hits[0]?.score.toFixed(3) ?? '–',
            })}
          </p>
          {result.hits.length === 0 && <p className={css.muted}>{t('recall.noHits')}</p>}
          <ol className={css.hits} aria-label={t('recall.results')}>
            {result.hits.map((hit, index) => (
              <li key={`${hit.itemId}:${String(hit.ordinal)}`} className={css.hit}>
                <div className={css.hitHead}>
                  <span className={css.hitRank}>#{index + 1}</span>
                  <span className={css.hitSource}>{t('recall.source', { name: hit.itemName, chunk: String(hit.ordinal + 1) })}</span>
                  <span className={css.hitScore}>{t('recall.score', { score: hit.score.toFixed(3) })}</span>
                </div>
                <p className={css.hitText}>{hit.text}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}
