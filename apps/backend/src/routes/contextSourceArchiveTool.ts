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
import { CHAT_TOOL_STEP_LIMIT } from './chatPrompts.js';
import {
  decodeContextSourceArchiveSearchCursor,
  encodeContextSourceArchiveSearchCursor,
} from './contextSourceArchiveCursor.js';
import {
  type ContextSourceArchiveSearchState,
  searchContextSourceArchivePage,
} from './contextSourceArchiveSearch.js';

const CONTEXT_SOURCE_ARCHIVE_OPERATIONS = [
  'tree',
  'list-directory',
  'search-text',
  'read-file',
  'resolve-lesson-selectors',
] as const;

type ContextSourceArchiveOperation = (typeof CONTEXT_SOURCE_ARCHIVE_OPERATIONS)[number];

interface ContextSourceArchiveToolInput {
  cursorBytes?: number;
  entryCursor?: number;
  operation: ContextSourceArchiveOperation;
  path?: string;
  query?: string;
  searchCursor?: string;
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

const CONTEXT_SOURCE_ARCHIVE_LIMIT_MESSAGE =
  'Il limite di consultazione dell’archivio sorgente è stato raggiunto.';
const CONTEXT_SOURCE_ARCHIVE_UNAVAILABLE_MESSAGE =
  'L’archivio sorgente non è disponibile oppure è cambiato.';
const CONTEXT_SOURCE_ARCHIVE_ERROR_MESSAGE =
  'Non è stato possibile consultare l’archivio sorgente.';

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
  if (
    typeof input.query !== 'string' ||
    !input.query ||
    input.query.length > MAX_CONTEXT_CHAT_FIELD_CHARS ||
    input.query.includes('\n') ||
    input.query.includes('\r')
  ) {
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
  if (input.entryCursor === undefined) return 0;
  if (!Number.isSafeInteger(input.entryCursor) || input.entryCursor < 0) {
    throw new SourceArchiveAccessError('cursor-invalid');
  }
  return input.entryCursor;
};

const createCitation = (
  archiveName: string,
  path: string,
  location?: { column: number; cursorBytes: number; line: number }
) => ({ archiveName, path, ...location });

export const createContextSourceArchiveTool = ({
  context,
  cursorSigningSecret,
  store,
}: {
  context: ContextSourceArchiveToolContext;
  cursorSigningSecret: string;
  store: ContextSourceArchiveStore;
}) => {
  if (!cursorSigningSecret) {
    throw new TypeError('Context source archive cursor signing secret is required.');
  }
  const encoder = new TextEncoder();
  let remainingResultBytes = MAX_CONTEXT_CHAT_FIELD_CHARS;
  let executionCount = 0;
  let scheduledExecutionCount = 0;
  let executionQueue = Promise.resolve();

  const serializedByteLength = (value: unknown): number =>
    encoder.encode(JSON.stringify(value)).byteLength;

  const futureTerminalReserve = (): number =>
    Math.max(0, CHAT_TOOL_STEP_LIMIT - executionCount) *
    serializedByteLength({ status: 'limit-reached' });

  const availableResultBytes = (): number =>
    Math.max(0, remainingResultBytes - futureTerminalReserve());

  const accountPayload = (...values: string[]): void => {
    const payloadBytes = values.reduce(
      (total, value) => total + encoder.encode(value).byteLength,
      0
    );
    if (payloadBytes > availableResultBytes()) {
      throw new ContextSourceArchiveToolBudgetError();
    }
    remainingResultBytes -= payloadBytes;
  };

  const accountResult = <TResult>(result: TResult): TResult => {
    accountPayload(JSON.stringify(result));
    return result;
  };

  const canAccountResult = (result: unknown): boolean =>
    serializedByteLength(result) <= availableResultBytes();

  const accountTerminalResult = <TResult extends { status: string }>(result: TResult) => {
    try {
      return accountResult(result);
    } catch (error) {
      if (!(error instanceof ContextSourceArchiveToolBudgetError)) throw error;
      return accountResult({ status: result.status });
    }
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
      entryCursor: cursor,
      entries: pageEntries,
      nextEntryCursor: candidateNextCursor,
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
      if (!canAccountResult(createResult(candidateNextCursor))) {
        pageEntries.pop();
        if (pageEntries.length === 0) {
          return accountResult({
            archiveName,
            citations: [],
            entryCursor: cursor,
            entries: [],
            message: CONTEXT_SOURCE_ARCHIVE_LIMIT_MESSAGE,
            nextEntryCursor: candidateNextCursor,
            omittedEntry: true,
            operation: input.operation,
            ...(path === undefined ? {} : { path }),
            status: 'limit-reached' as const,
          });
        }
        nextCursor = entryIndex;
        break;
      }
      entryIndex = candidateNextCursor;
    }

    return accountResult(createResult(nextCursor));
  };

  const readSearchState = (
    input: ContextSourceArchiveToolInput,
    query: string
  ): ContextSourceArchiveSearchState | undefined => {
    if (input.searchCursor === undefined) return undefined;
    if (!input.searchCursor || input.searchCursor.length > MAX_CONTEXT_CHAT_FIELD_CHARS) {
      throw new SourceArchiveAccessError('cursor-invalid');
    }
    const state = decodeContextSourceArchiveSearchCursor({
      cursor: input.searchCursor,
      scope: {
        archiveVersion: context.sourceReference.archiveVersion,
        projectId: context.projectId,
        query,
        userId: context.userId,
      },
      signingSecret: cursorSigningSecret,
    });
    if (!state) {
      throw new SourceArchiveAccessError('cursor-invalid');
    }
    return state;
  };

  const encodeSearchState = (query: string, state: ContextSourceArchiveSearchState): string =>
    encodeContextSourceArchiveSearchCursor({
      scope: {
        archiveVersion: context.sourceReference.archiveVersion,
        projectId: context.projectId,
        query,
        userId: context.userId,
      },
      signingSecret: cursorSigningSecret,
      state,
    });

  const buildSearchResult = async (
    access: ReturnType<typeof createProjectSourceArchiveAccess>,
    archiveName: string,
    input: ContextSourceArchiveToolInput,
    query: string
  ) => {
    const searchState = readSearchState(input, query);
    const page = await searchContextSourceArchivePage({
      access,
      maxPageBytes: availableResultBytes(),
      query,
      state: searchState,
    });
    const matches: (typeof page.candidates)[number]['match'][] = [];
    let continuationState = page.nextState;
    const createResult = (nextSearchCursor: string | null, status: 'no-match' | 'ok') => ({
      archiveName,
      citations: matches.map(match =>
        createCitation(archiveName, match.path, {
          column: match.column,
          cursorBytes: match.cursorBytes,
          line: match.line,
        })
      ),
      matches,
      nextSearchCursor,
      operation: input.operation,
      status,
    });

    for (const candidate of page.candidates) {
      matches.push(candidate.match);
      const candidateNextCursor = encodeSearchState(query, candidate.resumeState);
      if (!canAccountResult(createResult(candidateNextCursor, 'ok'))) {
        matches.pop();
        continuationState = candidate.retryState;
        break;
      }
    }

    if (matches.length > 0 && continuationState) {
      continuationState = { ...continuationState, matchedPreviously: true };
    }

    if (matches.length === 0 && page.candidates.length > 0) {
      const nextSearchCursor = encodeSearchState(query, page.candidates[0].resumeState);
      return accountTerminalResult({
        archiveName,
        citations: [],
        matches: [],
        message: CONTEXT_SOURCE_ARCHIVE_LIMIT_MESSAGE,
        nextSearchCursor,
        omittedMatch: true,
        operation: input.operation,
        status: 'limit-reached' as const,
      });
    }

    const nextSearchCursor = continuationState ? encodeSearchState(query, continuationState) : null;
    return accountResult(
      createResult(
        nextSearchCursor,
        matches.length || nextSearchCursor || searchState?.matchedPreviously ? 'ok' : 'no-match'
      )
    );
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
    if (canAccountResult(completeResult)) {
      return accountResult(completeResult);
    }

    const codePoints = Array.from(page.text);
    let lowerBound = 0;
    let upperBound = codePoints.length;
    let fittedResult: ReturnType<typeof createResult> | undefined;
    while (lowerBound <= upperBound) {
      const candidateLength = Math.floor((lowerBound + upperBound) / 2);
      const candidate = createResult(codePoints.slice(0, candidateLength).join(''));
      if (canAccountResult(candidate)) {
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
    if (availableResultBytes() <= 0) {
      throw new ContextSourceArchiveToolBudgetError();
    }
    const index = await store.loadProjectSourceArchiveIndex(context.userId, context.projectId);
    if (!index || !versionsMatch(index.version, context.sourceReference.archiveVersion)) {
      throw new ContextSourceArchiveUnavailableError();
    }
    return createProjectSourceArchiveAccess({
      index,
      maxContextBytes: availableResultBytes(),
      projectId: context.projectId,
      signal: context.signal,
      sourceUnavailableError: () => new ContextSourceArchiveUnavailableError(),
      store,
      userId: context.userId,
    });
  };

  const executeOperation = async (input: ContextSourceArchiveToolInput) => {
    executionCount += 1;
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
          const path = input.path === undefined ? '' : requirePath(input, true);
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
          const page = await access.readTextPage(path, cursorBytes, availableResultBytes());
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
          return await buildSearchResult(access, archiveName, input, query);
        }
      }
      const exhaustiveOperation: never = input.operation;
      throw new TypeError(`Unsupported context source archive operation: ${exhaustiveOperation}`);
    } catch (error) {
      if (
        error instanceof ContextSourceArchiveToolBudgetError ||
        (error instanceof SourceArchiveAccessError && error.code === 'context-limit-exceeded')
      ) {
        return accountTerminalResult({
          archiveName,
          citations: [],
          message: CONTEXT_SOURCE_ARCHIVE_LIMIT_MESSAGE,
          operation: input.operation,
          status: 'limit-reached' as const,
        });
      }
      if (error instanceof ContextSourceArchiveUnavailableError) {
        return accountTerminalResult({
          archiveName,
          citations: [],
          message: CONTEXT_SOURCE_ARCHIVE_UNAVAILABLE_MESSAGE,
          operation: input.operation,
          status: 'unavailable' as const,
        });
      }
      console.error('[Context source archive tool] Retrieval failed.', { error });
      return accountTerminalResult({
        archiveName,
        citations: [],
        message: CONTEXT_SOURCE_ARCHIVE_ERROR_MESSAGE,
        operation: input.operation,
        status: 'error' as const,
      });
    }
  };

  const execute = (input: ContextSourceArchiveToolInput) => {
    if (scheduledExecutionCount >= CHAT_TOOL_STEP_LIMIT) {
      return Promise.reject(new Error(CONTEXT_SOURCE_ARCHIVE_LIMIT_MESSAGE));
    }
    scheduledExecutionCount += 1;
    const result = executionQueue.then(() => executeOperation(input));
    executionQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return tool({
    description:
      'Inspect only the retained source archive for the current lesson. Resolve the lesson registered paths, browse the ordered index or a directory, search for a literal string, and read a text page from an exact path. Index pages use nextEntryCursor, searches use nextSearchCursor, and reads use nextCursorBytes to continue. Continue a search until nextSearchCursor is null before concluding that no matches exist. Outputs include the archive name and citations with exact paths. Search results include line, column, and cursorBytes usable with read-file.',
    execute,
    inputSchema: jsonSchema<ContextSourceArchiveToolInput>({
      type: 'object',
      additionalProperties: false,
      properties: {
        entryCursor: {
          type: 'integer',
          minimum: 0,
          description: 'nextEntryCursor returned by tree or list-directory.',
        },
        cursorBytes: {
          type: 'integer',
          minimum: 0,
          description: 'nextCursorBytes offset returned by a previous read-file operation.',
        },
        operation: {
          type: 'string',
          enum: [...CONTEXT_SOURCE_ARCHIVE_OPERATIONS],
        },
        path: { type: 'string' },
        query: { type: 'string', minLength: 1, maxLength: MAX_CONTEXT_CHAT_FIELD_CHARS },
        searchCursor: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_CONTEXT_CHAT_FIELD_CHARS,
          description: 'nextSearchCursor returned by a previous search-text operation.',
        },
      },
      required: ['operation'],
    }),
  });
};
