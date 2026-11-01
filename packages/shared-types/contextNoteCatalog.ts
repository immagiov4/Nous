import * as z from 'zod';
import { MAX_CONTEXT_CHAT_FIELD_CHARS } from './lessonSourceContext';

const SnapshotIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const PassageIdSchema = z.string().regex(/^(?:p[0-9a-z]+|s)$/u);
const PassageSchema = z
  .object({ kind: z.enum(['paragraph', 'heading', 'tableCell']), id: PassageIdSchema })
  .strict();
const ContextSchema = z.object({ kind: z.literal('context'), text: z.string() }).strict();
export type ContextNoteRecord = z.infer<typeof PassageSchema> | z.infer<typeof ContextSchema>;
export const getContextNotePassageIds = (
  records: ContextNoteRecord[] = [],
  selectionId?: string
) => [
  ...records.flatMap(record => (record.kind === 'context' ? [] : [record.id])),
  ...(selectionId ? [selectionId] : []),
];
export const serializeContextNoteView = (records: ContextNoteRecord[]) =>
  records.map(record => (record.kind === 'context' ? record.text : `⟦${record.id}⟧`)).join('');
/** The existing field budget counts original Markdown; marker metadata cannot evict lesson text. */
export const ContextNoteCatalogSchema = z
  .object({
    records: z.array(z.union([PassageSchema, ContextSchema])),
    snapshotId: SnapshotIdSchema,
    selectionId: z.literal('s').optional(),
  })
  .strict()
  .refine(({ records, selectionId }) => {
    const ids = getContextNotePassageIds(records, selectionId);
    const sourceChars = records.reduce(
      (sum, record) => sum + (record.kind === 'context' ? record.text.length : 0),
      0
    );
    return (
      new Set(ids).size === ids.length &&
      sourceChars <= MAX_CONTEXT_CHAT_FIELD_CHARS &&
      records.filter(record => record.kind !== 'context').length <= sourceChars
    );
  });

export const readContextNoteSnapshotId = (metadata: unknown): string | undefined => {
  const parsed = z.object({ contextNoteSnapshotId: SnapshotIdSchema }).safeParse(metadata);
  return parsed.success ? parsed.data.contextNoteSnapshotId : undefined;
};
