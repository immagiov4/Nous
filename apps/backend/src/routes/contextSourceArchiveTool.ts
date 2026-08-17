import {
  type ContextSourceReference,
  MAX_CONTEXT_CHAT_FIELD_CHARS,
} from '@shared/lessonSourceContext';
import { jsonSchema, tool } from 'ai';

import {
  createProjectSourceArchiveAccess,
  SourceArchiveAccessError,
  type SourceArchiveIndexedEntry,
  type SourceArchiveTextPage,
} from '../projects/sourceArchiveAccess.js';
import type { ProjectSourceArchiveVersion, ProjectStore } from '../projects/types.js';

export const CONTEXT_SOURCE_ARCHIVE_TOOL_NAME = 'retrieveSourceArchive' as const;

type ContextSourceArchiveOperation =
  | 'list-directory'
  | 'read-file'
  | 'resolve-lesson-selectors'
  | 'search-text'
  | 'tree';

interface ContextSourceArchiveToolInput {
  cursor?: number;
  cursorBytes?: number;
  operation: ContextSourceArchiveOperation;
  path?: string;
  query?: string;
}

interface ContextSourceArchiveToolContext {
  projectId: string;
  signal: AbortSignal;
  sourceReference: ContextSourceReference & {
    archiveVersion: ProjectSourceArchiveVersion;
  };
  userId: string;
}

type ContextSourceArchiveStore = Pick<
  ProjectStore,
  | 'loadProjectSourceArchiveEntry'
  | 'loadProjectSourceArchiveEntryRange'
  | 'loadProjectSourceArchiveIndex'
>;

class ContextSourceArchiveUnavailableError extends Error {
  constructor() {
    super('Context source archive is unavailable or changed.');
    this.name = 'ContextSourceArchiveUnavailableError';
  }
}

class ContextSourceArchiveToolBudgetError extends Error {
  constructor() {
    super('Context source archive tool result budget exceeded.');
    this.name = 'ContextSourceArchiveToolBudgetError';
  }
}

const versionsMatch = (
  current: ProjectSourceArchiveVersion,
  expected: ProjectSourceArchiveVersion
): boolean =>
  current.representationHash === expected.representationHash &&
  current.sourceHash === expected.sourceHash &&
  current.sourceId === expected.sourceId;

const requirePath = (input: ContextSourceArchiveToolInput, allowEmpty = false): string => {
  if (typeof input.path !== 'string' || (!allowEmpty && !input.path)) {
    throw new SourceArchiveAccessError('path-not-found');
  }
  return input.path;
};

const requireQuery = (input: ContextSourceArchiveToolInput): string => {
  if (typeof input.query !== 'string') {
    throw new SourceArchiveAccessError('query-invalid');
  }
  return input.query;
};

const readCursor = (input: ContextSourceArchiveToolInput): number => {
  if (input.cursorBytes === undefined) return 0;
  if (!Number.isSafeInteger(input.cursorBytes) || input.cursorBytes < 0) {
    throw new SourceArchiveAccessError('cursor-invalid');
  }
  return input.cursorBytes;
};

const readEntryCursor = (input: ContextSourceArchiveToolInput): number => {
  if (input.cursor === undefined) return 0;
  if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) {
    throw new SourceArchiveAccessError('cursor-invalid');
  }
  return input.cursor;
};

const createCitation = (
  archiveName: string,
  path: string,
  location?: { column: number; line: number }
) => ({ archiveName, path, ...location });

export const createContextSourceArchiveTool = ({
  context,
  store,
}: {
  context: ContextSourceArchiveToolContext;
  store: ContextSourceArchiveStore;
}) => {
  const encoder = new TextEncoder();
  let remainingResultBytes = MAX_CONTEXT_CHAT_FIELD_CHARS;

  const accountPayload = (...values: string[]): void => {
    const payloadBytes = values.reduce(
      (total, value) => total + encoder.encode(value).byteLength,
      0
    );
    if (payloadBytes > remainingResultBytes) {
      throw new ContextSourceArchiveToolBudgetError();
    }
    remainingResultBytes -= payloadBytes;
  };

  const accountResult = <TResult>(result: TResult): TResult => {
    accountPayload(JSON.stringify(result));
    return result;
  };

  const buildEntryPage = ({
    archiveName,
    citations,
    entries,
    input,
    path,
  }: {
    archiveName: string;
    citations: ReturnType<typeof createCitation>[];
    entries: Iterable<SourceArchiveIndexedEntry>;
    input: ContextSourceArchiveToolInput;
    path?: string;
  }) => {
    const cursor = readEntryCursor(input);
    const pageEntries: SourceArchiveIndexedEntry[] = [];
    let entryIndex = 0;
    let nextCursor: number | null = null;

    const createResult = (candidateNextCursor: number | null) => ({
      archiveName,
      citations,
      cursor,
      entries: pageEntries,
      nextCursor: candidateNextCursor,
      operation: input.operation,
      ...(path === undefined ? {} : { path }),
      status: 'ok' as const,
    });

    for (const entry of entries) {
      if (entryIndex < cursor) {
        entryIndex += 1;
        continue;
      }
      pageEntries.push(entry);
      const candidateNextCursor = entryIndex + 1;
      if (
        encoder.encode(JSON.stringify(createResult(candidateNextCursor))).byteLength >
        remainingResultBytes
      ) {
        pageEntries.pop();
        if (pageEntries.length === 0) throw new ContextSourceArchiveToolBudgetError();
        nextCursor = entryIndex;
        break;
      }
      entryIndex = candidateNextCursor;
    }

    return accountResult(createResult(nextCursor));
  };

  const buildReadResult = (
    archiveName: string,
    input: ContextSourceArchiveToolInput,
    page: SourceArchiveTextPage
  ) => {
    const createResult = (text: string) => {
      const textBytes = encoder.encode(text).byteLength;
      const endByteExclusive = page.cursorBytes + textBytes;
      return {
        archiveName,
        citations: [createCitation(archiveName, page.path)],
        operation: input.operation,
        page: {
          ...page,
          endByteExclusive,
          nextCursorBytes: endByteExclusive === page.totalBytes ? null : endByteExclusive,
          text,
        },
        status: 'ok' as const,
      };
    };

    const completeResult = createResult(page.text);
    if (encoder.encode(JSON.stringify(completeResult)).byteLength <= remainingResultBytes) {
      return accountResult(completeResult);
    }

    const codePoints = Array.from(page.text);
    let lowerBound = 0;
    let upperBound = codePoints.length;
    let fittedResult: ReturnType<typeof createResult> | undefined;
    while (lowerBound <= upperBound) {
      const candidateLength = Math.floor((lowerBound + upperBound) / 2);
      const candidate = createResult(codePoints.slice(0, candidateLength).join(''));
      if (encoder.encode(JSON.stringify(candidate)).byteLength <= remainingResultBytes) {
        fittedResult = candidate;
        lowerBound = candidateLength + 1;
      } else {
        upperBound = candidateLength - 1;
      }
    }
    if (!fittedResult || (page.text && !fittedResult.page.text)) {
      throw new ContextSourceArchiveToolBudgetError();
    }
    return accountResult(fittedResult);
  };

  const openArchive = async () => {
    if (remainingResultBytes <= 0) {
      throw new ContextSourceArchiveToolBudgetError();
    }
    const index = await store.loadProjectSourceArchiveIndex(context.userId, context.projectId);
    if (!index || !versionsMatch(index.version, context.sourceReference.archiveVersion)) {
      throw new ContextSourceArchiveUnavailableError();
    }
    return createProjectSourceArchiveAccess({
      index,
      maxContextBytes: remainingResultBytes,
      projectId: context.projectId,
      signal: context.signal,
      sourceUnavailableError: () => new ContextSourceArchiveUnavailableError(),
      store,
      userId: context.userId,
    });
  };

  const execute = async (input: ContextSourceArchiveToolInput) => {
    const { name: archiveName } = context.sourceReference;
    try {
      const access = await openArchive();
      switch (input.operation) {
        case 'tree': {
          return buildEntryPage({
            archiveName,
            citations: [],
            entries: access.iterateEntries(),
            input,
          });
        }
        case 'list-directory': {
          const path = requirePath(input, true);
          return buildEntryPage({
            archiveName,
            citations: path ? [createCitation(archiveName, path)] : [],
            entries: access.iterateDirectory(path),
            input,
            path,
          });
        }
        case 'read-file': {
          const path = requirePath(input);
          const cursorBytes = readCursor(input);
          const page = await access.readTextPage(path, cursorBytes, remainingResultBytes);
          return buildReadResult(archiveName, input, page);
        }
        case 'resolve-lesson-selectors': {
          const selectors = context.sourceReference.archiveSelectors || [];
          if (selectors.length === 0) {
            return accountResult({
              archiveName,
              citations: [],
              files: [],
              operation: input.operation,
              status: 'no-match' as const,
            });
          }
          const files = await access.resolveSelectors(selectors);
          return accountResult({
            archiveName,
            citations: files.map(file => createCitation(archiveName, file.path)),
            files,
            operation: input.operation,
            status: files.length ? ('ok' as const) : ('no-match' as const),
          });
        }
        case 'search-text': {
          const query = requireQuery(input);
          const matches = await access.searchLiteral(query);
          return accountResult({
            archiveName,
            citations: matches.map(match =>
              createCitation(archiveName, match.path, {
                column: match.column,
                line: match.line,
              })
            ),
            matches,
            operation: input.operation,
            query,
            status: matches.length ? ('ok' as const) : ('no-match' as const),
          });
        }
      }
      const exhaustiveOperation: never = input.operation;
      throw new TypeError(`Unsupported context source archive operation: ${exhaustiveOperation}`);
    } catch (error) {
      if (error instanceof ContextSourceArchiveToolBudgetError) {
        return {
          archiveName,
          citations: [],
          message: 'Il limite di consultazione dell archivio sorgente e stato raggiunto.',
          operation: input.operation,
          status: 'limit-reached' as const,
        };
      }
      if (error instanceof ContextSourceArchiveUnavailableError) {
        return {
          archiveName,
          citations: [],
          message: 'L’archivio sorgente non è disponibile oppure è cambiato.',
          operation: input.operation,
          status: 'unavailable' as const,
        };
      }
      console.error('[Context source archive tool] Retrieval failed.', { error });
      return {
        archiveName,
        citations: [],
        message: 'Non è stato possibile consultare l’archivio sorgente.',
        operation: input.operation,
        status: 'error' as const,
      };
    }
  };

  return tool({
    description:
      'Consulta esclusivamente l archivio sorgente conservato per la lezione corrente. Consente di risolvere i percorsi registrati della lezione, scorrere l indice ordinato o una cartella, cercare una stringa letterale e leggere una pagina testuale da un percorso esatto. Le pagine di indice usano cursor e le letture usano cursorBytes per continuare. Gli output includono il nome dell archivio e citazioni con percorsi esatti; le ricerche includono riga e colonna.',
    execute,
    inputSchema: jsonSchema<ContextSourceArchiveToolInput>({
      type: 'object',
      additionalProperties: false,
      properties: {
        cursor: {
          type: 'integer',
          minimum: 0,
          description:
            'Indice nextCursor restituito da una precedente operazione tree o list-directory.',
        },
        cursorBytes: {
          type: 'integer',
          minimum: 0,
          description: 'Offset nextCursorBytes restituito da una precedente operazione read-file.',
        },
        operation: {
          type: 'string',
          enum: ['tree', 'list-directory', 'search-text', 'read-file', 'resolve-lesson-selectors'],
        },
        path: { type: 'string' },
        query: { type: 'string', minLength: 1 },
      },
      required: ['operation'],
    }),
  });
};
