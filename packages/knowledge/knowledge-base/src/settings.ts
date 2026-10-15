/** A knowledge base's chunking and retrieval settings, as `base.json` and the user center hold them. */
import { z } from 'zod'

/** Chunking and retrieval settings with their bounds; defaults follow Cherry Studio's. */
export const settingsShape = {
  chunkStrategy: z.enum(['structured', 'delimiter']),
  chunkSeparator: z.string(),
  chunkSize: z.number().int().positive(),
  chunkOverlap: z.number().int().nonnegative(),
  documentCount: z.number().int().min(1).max(50),
  threshold: z.number().min(0).max(1),
}
