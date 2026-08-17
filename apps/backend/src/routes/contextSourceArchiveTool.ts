import {
  type ContextSourceReference,
  MAX_CONTEXT_CHAT_FIELD_CHARS,
} from '@shared/lessonSourceContext';
import { jsonSchema, tool } from 'ai';

import {
  createProjectSourceArchiveAccess,
  SourceArchiveAccessError,
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
          const entries = access.getTree();
          return accountResult({
            archiveName,
            citations: [],
            entries,
            operation: input.operation,
            status: 'ok' as const,
          });
        }
        case 'list-directory': {
          const path = requirePath(input, true);
          const entries = access.listDirectory(path);
          return accountResult({
            archiveName,
            citations: path ? [createCitation(archiveName, path)] : [],
            entries,
            operation: input.operation,
            path,
            status: 'ok' as const,
          });
        }
        case 'read-file': {
          const path = requirePath(input);
          const cursorBytes = readCursor(input);
          const maximumPageNumber = Number.MAX_SAFE_INTEGER;
          const resultOverheadBytes = encoder.encode(
            JSON.stringify({
              archiveName,
              citations: [createCitation(archiveName, path)],
              operation: input.operation,
              page: {
                cursorBytes: maximumPageNumber,
                endByteExclusive: maximumPageNumber,
                nextCursorBytes: maximumPageNumber,
                path,
                text: '',
                totalBytes: maximumPageNumber,
              },
              status: 'ok',
            })
          ).byteLength;
          const maximumPageBytes = remainingResultBytes - resultOverheadBytes;
          if (maximumPageBytes <= 0) throw new ContextSourceArchiveToolBudgetError();
          const page = await access.readTextPage(path, cursorBytes, maximumPageBytes);
          return accountResult({
            archiveName,
            citations: [createCitation(archiveName, page.path)],
            operation: input.operation,
            page,
            status: 'ok' as const,
          });
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
    } catch (error) {
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
      'Consulta esclusivamente l archivio sorgente conservato per la lezione corrente. Consente di risolvere i percorsi registrati della lezione, vedere l albero, elencare una cartella, cercare una stringa letterale e leggere una pagina testuale da un percorso esatto. Gli output includono il nome dell archivio e citazioni con percorsi esatti; le ricerche includono riga e colonna.',
    execute,
    inputSchema: jsonSchema<ContextSourceArchiveToolInput>({
      type: 'object',
      additionalProperties: false,
      properties: {
        cursorBytes: { type: 'integer', minimum: 0 },
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
