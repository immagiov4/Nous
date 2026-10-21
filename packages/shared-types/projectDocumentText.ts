export const PROJECT_DOCUMENT_TEXT_HEADER = 'X-Nous-Document-Text';
export const PROJECT_DEFERRED_WRITE_SUFFIX = '/deferred';

interface DocumentTextState {
  documentIndex?: { textDeferred?: unknown } | null;
  source?: { sources?: readonly { documentIndex?: { textDeferred?: unknown } | null }[] } | null;
}

export const hasDeferredDocumentText = (snapshot: DocumentTextState): boolean =>
  snapshot.documentIndex?.textDeferred === true ||
  snapshot.source?.sources?.some(source => source.documentIndex?.textDeferred === true) === true;
