import { hasDeferredDocumentText } from '@shared/projectDocumentText';
import type { PdfTextIndex, ProjectSource } from '../../types';
import { readSupabaseSession } from '../auth/supabaseAuth';
import { HttpProjectRepository } from './httpProjectRepository';
import { PROJECT_REVISION_CONFLICT_MESSAGE, ProjectStorageError } from './projectRepository';

interface DocumentText {
  documentIndex: PdfTextIndex | null;
  source: ProjectSource | null;
}
const pending = new Map<string, Promise<DocumentText>>();
let ownerId: string | undefined;
const repository = new HttpProjectRepository();
export const documentTextSourceIdentity = (source: ProjectSource | null): string =>
  JSON.stringify({
    kind: source?.kind,
    ref: source?.ref,
    sources: source?.sources?.map(descriptor => ({
      id: descriptor.id,
      hash: descriptor.hash,
      parsedAt: descriptor.documentIndex?.parsedAt,
    })),
  });

/** Shares the first source-text request for a loaded snapshot without changing autosave state. */
export const loadDocumentText = async (
  projectId: string | null,
  current: DocumentText
): Promise<DocumentText> => {
  if (!hasDeferredDocumentText(current)) return current;
  if (!projectId)
    throw new ProjectStorageError(PROJECT_REVISION_CONFLICT_MESSAGE, 'revision-conflict');
  const userId = readSupabaseSession()?.user?.id;
  if (ownerId !== userId) {
    pending.clear();
    ownerId = userId;
  }
  const hasSourceIndexes = current.source?.sources?.some(source => source.documentIndex != null);
  const identity = JSON.stringify([
    userId,
    projectId,
    documentTextSourceIdentity(current.source),
    ...(hasSourceIndexes
      ? []
      : [current.documentIndex?.parsedAt, current.documentIndex?.sourceHash]),
  ]);
  let request = pending.get(identity);
  if (!request) {
    request = repository
      .loadProjectWithRevision(projectId, { includeDocumentText: true })
      .then(record => {
        const index = record?.snapshot.documentIndex;
        if (
          !record ||
          index?.textDeferred === true ||
          record.snapshot.source?.sources?.some(source => source.documentIndex?.textDeferred) ||
          (current.documentIndex != null &&
            (index?.parsedAt !== current.documentIndex.parsedAt ||
              index?.sourceHash !== current.documentIndex.sourceHash)) ||
          documentTextSourceIdentity(record.snapshot.source) !==
            documentTextSourceIdentity(current.source)
        )
          throw new ProjectStorageError(PROJECT_REVISION_CONFLICT_MESSAGE, 'revision-conflict');
        return { documentIndex: index ?? null, source: record.snapshot.source };
      })
      .catch(error => {
        if (pending.get(identity) === request) pending.delete(identity);
        throw error;
      });
    pending.set(identity, request);
  }
  return request;
};
