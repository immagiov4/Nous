import { isRecord } from '../utils/validation.js';

const deferIndex = (index: unknown): unknown => {
  if (!isRecord(index) || !Array.isArray(index.chunks)) return index;
  return {
    ...index,
    textDeferred: true,
    chunks: index.chunks.map(chunk => (isRecord(chunk) ? { ...chunk, text: '' } : chunk)),
  };
};

/** Keeps source navigation metadata in course responses; text remains authoritative in storage. */
export const deferProjectDocumentText = <T extends { documentIndex?: unknown; source?: unknown }>(
  snapshot: T
): T => {
  const deferSource = (source: unknown): unknown => {
    if (!isRecord(source)) return source;
    const { preparedPdfText, ...descriptor } = source;
    const prepared = isRecord(preparedPdfText)
      ? {
          ...preparedPdfText,
          text: '',
          ...(Array.isArray(preparedPdfText.pages)
            ? {
                pages: preparedPdfText.pages.map(page =>
                  isRecord(page) ? { ...page, text: '' } : page
                ),
              }
            : {}),
        }
      : undefined;
    return {
      ...descriptor,
      ...(prepared ? { preparedPdfText: prepared } : {}),
      ...(source.documentIndex ? { documentIndex: deferIndex(source.documentIndex) } : {}),
    };
  };
  const source = deferSource(snapshot.source);
  return {
    ...snapshot,
    ...(snapshot.documentIndex ? { documentIndex: deferIndex(snapshot.documentIndex) } : {}),
    ...(isRecord(source)
      ? {
          source: {
            ...source,
            ...(Array.isArray(source.sources) ? { sources: source.sources.map(deferSource) } : {}),
          },
        }
      : {}),
  };
};

const restoreIndex = (incoming: unknown, stored: unknown): unknown => {
  if (incoming == null) return stored ?? incoming;
  if (!isRecord(incoming) || incoming.textDeferred !== true) return incoming;
  if (!isRecord(stored) || stored.textDeferred === true)
    throw new Error('Deferred document text has no stored index.');
  return stored;
};

/** A deferred or omitted index means unchanged, including writes from an unopened source. */
export const restoreProjectDocumentText = <T extends { documentIndex?: unknown; source?: unknown }>(
  snapshot: T,
  previous: { documentIndex?: unknown; source?: unknown } | null
): T & { documentIndex?: unknown } => {
  const storedSources =
    isRecord(previous?.source) && Array.isArray(previous.source.sources)
      ? previous.source.sources
      : [];
  const source =
    isRecord(snapshot.source) && Array.isArray(snapshot.source.sources)
      ? {
          ...snapshot.source,
          sources: snapshot.source.sources.map(descriptor => {
            if (!isRecord(descriptor)) return descriptor;
            const stored = storedSources.find(
              source => isRecord(source) && source.id === descriptor.id
            );
            return {
              ...descriptor,
              documentIndex: restoreIndex(
                descriptor.documentIndex,
                isRecord(stored) ? stored.documentIndex : undefined
              ),
            };
          }),
        }
      : snapshot.source;
  return {
    ...snapshot,
    source,
    documentIndex: restoreIndex(snapshot.documentIndex, previous?.documentIndex),
  };
};
