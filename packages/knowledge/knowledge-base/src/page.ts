/**
 * Turning a fetched web page into Markdown: Mozilla Readability picks the article out of the page,
 * over a linkedom document, and turndown writes it as Markdown. Only the page itself is used; its
 * links are not followed.
 */
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.remove(['script', 'style', 'noscript', 'iframe'])

/** A page's article. */
export interface PageArticle {
  /** Page title; empty when the page has none. */
  readonly title: string
  readonly markdown: string
}

/**
 * Extract a page's article as Markdown.
 * @param html - the page.
 * @param url - its address, against which relative links resolve.
 * @returns the title and the article; the whole body when Readability finds no article.
 */
export function pageToMarkdown(html: string, url: string): PageArticle {
  // linkedom builds a document only from a whole page; a bare fragment goes into a body.
  const { document } = parseHTML(/<html[\s>]/iu.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`)
  const base = document.createElement('base')
  base.setAttribute('href', url)
  document.head.append(base)
  const title = document.title.trim()
  // Readability changes the document it reads, so it reads a copy, leaving the body for the fallback.
  const article = new Readability(document.cloneNode(true) as Document).parse()
  const fromArticle = turndown.turndown(article?.content ?? '').trim()
  // An article too short to be told from the page leaves Readability with nothing; the body is the page then.
  const markdown = fromArticle === '' ? turndown.turndown(document.body.innerHTML).trim() : fromArticle
  return { title: article?.title?.trim() || title, markdown }
}
