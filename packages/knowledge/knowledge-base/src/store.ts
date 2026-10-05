/**
 * One knowledge base's index: an SQLite file holding its items, their chunks with embedding
 * vectors, and a contentless FTS5 index over the chunks' keyword terms. Search is hybrid: cosine
 * similarity over every vector, blended with BM25 normalized against the best keyword match.
 */
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { KnowledgeItemError, KnowledgeItemKind, KnowledgeItemStatus, KnowledgeSearchHit, KnowledgeSkippedFile } from './types.ts'
import { matchExpression, terms } from './terms.ts'

/** One stored item. */
export interface ItemRow {
  id: string
  kind: KnowledgeItemKind
  /** The folder item a file found in a folder belongs to. */
  parentId: string | null
  /** Display name: file name, folder name, page title, or note title. */
  name: string
  /** Folder path, page URL, or a folder file's path relative to its folder; null for files and notes. */
  source: string | null
  size: number
  /** Modification time of a folder file when last copied, in milliseconds. */
  modifiedAt: number | null
  /** Files of a folder left out, with why: a listed few of `skippedCount`. */
  skipped: readonly KnowledgeSkippedFile[]
  skippedCount: number
  status: KnowledgeItemStatus
  error: KnowledgeItemError | null
  chunkCount: number
  addedAt: string
}

/** A new item: kind, parent, source, modification time, and skipped files default to a plain file. */
export type NewItem = Pick<ItemRow, 'id' | 'name' | 'size' | 'status' | 'error' | 'chunkCount' | 'addedAt'> & Partial<ItemRow>

/** Item fields a later scan, fetch, or edit changes. */
export type ItemUpdate = Partial<Pick<ItemRow, 'name' | 'source' | 'size' | 'modifiedAt' | 'skipped' | 'skippedCount'>>

/** Columns added after the first release, with their definitions, for indexes created before them. */
const ADDED_COLUMNS: readonly [string, string][] = [
  ['kind', "text not null default 'file'"], ['parent_id', 'text'], ['source', 'text'], ['modified_at', 'real'],
  ['skipped', "text not null default '[]'"], ['skipped_count', 'integer not null default 0'],
]


/** Weight of vector similarity in the blended score; the rest is the keyword match. */
const VECTOR_WEIGHT = 0.7

const SCHEMA = `
create table if not exists items (
  id text primary key, name text not null, size integer not null, status text not null,
  error text, chunk_count integer not null default 0, added_at text not null
);
create table if not exists chunks (
  id integer primary key, item_id text not null, ordinal integer not null, text text not null, vector blob not null
);
create index if not exists chunks_by_item on chunks(item_id);
create virtual table if not exists chunk_terms using fts5(terms, content='', contentless_delete=1);
`

type Row = Record<string, SQLOutputValue>
const text = (row: Row, key: string): string => String(row[key])
const num = (row: Row, key: string): number => Number(row[key])

const toBlob = (vector: readonly number[]): Uint8Array => new Uint8Array(Float32Array.from(vector).buffer)
const fromBlob = (blob: Uint8Array): Float32Array => new Float32Array(Uint8Array.from(blob).buffer)

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let left = 0
  let right = 0
  // Vectors from one embedding model share a length.
  for (let index = 0; index < a.length; index++) {
    const x = a[index] as number
    const y = b[index] as number
    dot += x * y
    left += x * x
    right += y * y
  }
  return left === 0 || right === 0 ? 0 : dot / Math.sqrt(left * right)
}

/** An open knowledge base index. */
export class BaseStore {
  private readonly db: DatabaseSync

  /** @param path - SQLite file, created when missing. */
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(SCHEMA)
    const present = new Set(this.db.prepare('pragma table_info(items)').all().map(row => text(row, 'name')))
    for (const [column, definition] of ADDED_COLUMNS) {
      if (!present.has(column)) this.db.exec(`alter table items add column ${column} ${definition}`)
    }
  }

  /**
   * List the items.
   * @returns every item, oldest first.
   */
  items(): ItemRow[] {
    return this.db.prepare('select * from items order by added_at, rowid').all().map(row => ({
      id: text(row, 'id'), name: text(row, 'name'), size: num(row, 'size'),
      // Written only by this class, from these unions and JSON.
      kind: text(row, 'kind') as KnowledgeItemKind,
      parentId: row.parent_id === null ? null : text(row, 'parent_id'),
      source: row.source === null ? null : text(row, 'source'),
      modifiedAt: row.modified_at === null ? null : num(row, 'modified_at'),
      skipped: JSON.parse(text(row, 'skipped')) as KnowledgeSkippedFile[], skippedCount: num(row, 'skipped_count'),
      // Written only by this class, from these unions.
      status: text(row, 'status') as KnowledgeItemStatus,
      error: row.error === null ? null : text(row, 'error') as KnowledgeItemError,
      chunkCount: num(row, 'chunk_count'), addedAt: text(row, 'added_at'),
    }))
  }

  /**
   * Record a new item.
   * @param item - the new item.
   */
  addItem(item: NewItem): void {
    this.db.prepare(`insert into items
      (id, kind, parent_id, name, source, size, modified_at, skipped, skipped_count, status, error, chunk_count, added_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id, item.kind ?? 'file', item.parentId ?? null, item.name, item.source ?? null, item.size, item.modifiedAt ?? null,
      JSON.stringify(item.skipped ?? []), item.skippedCount ?? 0, item.status, item.error, item.chunkCount, item.addedAt,
    )
  }

  /**
   * Change an item's name, source, size, modification time, or skipped files.
   * @param id - item id.
   * @param update - the fields to change.
   */
  updateItem(id: string, update: ItemUpdate): void {
    const columns: Record<keyof ItemUpdate, string> = {
      name: 'name', source: 'source', size: 'size', modifiedAt: 'modified_at', skipped: 'skipped', skippedCount: 'skipped_count',
    }
    for (const [key, value] of Object.entries(update)) {
      const column = columns[key as keyof ItemUpdate]
      this.db.prepare(`update items set ${column} = ? where id = ?`).run(key === 'skipped' ? JSON.stringify(value) : value as string | number | null, id)
    }
  }

  /**
   * Set an item's status.
   * @param id - item id.
   * @param status - new status.
   * @param error - failure reason, null otherwise.
   */
  setStatus(id: string, status: KnowledgeItemStatus, error: KnowledgeItemError | null): void {
    this.db.prepare('update items set status = ?, error = ? where id = ?').run(status, error, id)
  }

  /**
   * Replace an item's chunks and mark it completed, in one transaction.
   * @param id - item id.
   * @param chunks - chunk texts with their vectors, in order.
   */
  complete(id: string, chunks: readonly { text: string; vector: readonly number[] }[]): void {
    this.transaction(() => {
      this.removeChunks(id)
      const insert = this.db.prepare('insert into chunks (item_id, ordinal, text, vector) values (?, ?, ?, ?)')
      const index = this.db.prepare('insert into chunk_terms (rowid, terms) values (?, ?)')
      chunks.forEach((chunk, ordinal) => {
        const { lastInsertRowid } = insert.run(id, ordinal, chunk.text, toBlob(chunk.vector))
        index.run(lastInsertRowid, terms(chunk.text).join(' '))
      })
      this.db.prepare('update items set status = ?, error = null, chunk_count = ? where id = ?').run('completed', chunks.length, id)
    })
  }

  /**
   * Delete an item with its chunks.
   * @param id - item id.
   */
  deleteItem(id: string): void {
    this.transaction(() => {
      this.removeChunks(id)
      this.db.prepare('delete from items where id = ?').run(id)
    })
  }

  /**
   * Queue every item again.
   * @param dropChunks - also delete every chunk, as when the embedding model changes and old vectors no longer compare.
   */
  requeueAll(dropChunks: boolean): void {
    this.transaction(() => {
      if (dropChunks) {
        this.db.exec('delete from chunk_terms; delete from chunks')
        this.db.exec('update items set chunk_count = 0')
      }
      // A folder is never processed itself; its files are.
      this.db.exec("update items set status = 'pending', error = null where kind != 'folder'")
    })
  }

  /**
   * Hybrid search.
   * @param vector - the query's embedding.
   * @param query - the query text, for keyword matching.
   * @param limit - most hits to return.
   * @param threshold - least blended score kept.
   * @returns hits, best first.
   */
  search(vector: readonly number[], query: string, limit: number, threshold: number): KnowledgeSearchHit[] {
    // An item's chunks stay searchable until a new processing replaces them, whatever its status.
    const rows = this.db.prepare(`select chunks.id, item_id, items.name, ordinal, text, vector
      from chunks join items on items.id = chunks.item_id`).all()
    const keyword = new Map<number, number>()
    let best = 0
    const match = matchExpression(query)
    if (match !== undefined) {
      // bm25() is lower for better matches and never positive.
      for (const row of this.db.prepare('select rowid, -bm25(chunk_terms) as rank from chunk_terms where chunk_terms match ?').all(match)) {
        const rank = num(row, 'rank')
        keyword.set(num(row, 'rowid'), rank)
        if (rank > best) best = rank
      }
    }
    return rows
      .map((row) => {
        const similarity = Math.max(0, cosine(vector, fromBlob(row.vector as Uint8Array)))
        const keywordScore = best === 0 ? 0 : (keyword.get(num(row, 'id')) ?? 0) / best
        return {
          itemId: text(row, 'item_id'), itemName: text(row, 'name'), ordinal: num(row, 'ordinal'), text: text(row, 'text'),
          score: VECTOR_WEIGHT * similarity + (1 - VECTOR_WEIGHT) * keywordScore,
        }
      })
      .filter(hit => hit.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** Close the file. */
  close(): void { this.db.close() }

  private removeChunks(id: string): void {
    for (const row of this.db.prepare('select id from chunks where item_id = ?').all(id)) {
      this.db.prepare('delete from chunk_terms where rowid = ?').run(num(row, 'id'))
    }
    this.db.prepare('delete from chunks where item_id = ?').run(id)
  }

  private transaction(work: () => void): void {
    this.db.exec('begin')
    try {
      work()
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }
}
