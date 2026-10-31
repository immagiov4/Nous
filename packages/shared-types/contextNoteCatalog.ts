import * as z from 'zod';
import { MAX_CONTEXT_CHAT_FIELD_CHARS } from './lessonSourceContext';

const PassageSchema = z
  .object({
    kind: z.enum(['paragraph', 'heading', 'tableCell', 'selection']),
    id: z.string().regex(/^[\da-f-]{36}:\d+$/u),
    text: z.string().min(1),
  })
  .strict();
const ContextSchema = z.object({ kind: z.literal('context'), text: z.string() }).strict();
export type ContextNoteRecord = z.infer<typeof PassageSchema> | z.infer<typeof ContextSchema>;
export const getContextNotePassageIds = (records: ContextNoteRecord[] = []) =>
  records.flatMap(record => (record.kind === 'context' ? [] : [record.id]));
export const serializeContextNoteView = (records: ContextNoteRecord[]) =>
  records.map(record => JSON.stringify(record)).join('\n');
export const ContextNoteCatalogSchema = z
  .object({
    records: z.array(z.union([PassageSchema, ContextSchema])),
  })
  .strict()
  .refine(({ records }) => {
    const ids = getContextNotePassageIds(records);
    return (
      new Set(ids).size === ids.length &&
      serializeContextNoteView(records).length <= MAX_CONTEXT_CHAT_FIELD_CHARS
    );
  });

/** Keep complete JSON records within the existing lesson-field budget. A clipped tail is context only. */
export const fitContextNoteView = (records: ContextNoteRecord[]): ContextNoteRecord[] => {
  const included: ContextNoteRecord[] = [];
  let remaining = MAX_CONTEXT_CHAT_FIELD_CHARS;
  for (const record of records) {
    const separatorSize = included.length ? 1 : 0;
    const size = JSON.stringify(record).length + separatorSize;
    if (size <= remaining) {
      included.push(record);
      remaining -= size;
      continue;
    }
    let low = 0;
    let high = record.text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        JSON.stringify({ kind: 'context', text: record.text.slice(0, middle) }).length +
          separatorSize <=
        remaining
      )
        low = middle;
      else high = middle - 1;
    }
    if (low) included.push({ kind: 'context', text: record.text.slice(0, low) });
    break;
  }
  return included;
};
