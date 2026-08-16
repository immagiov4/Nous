import type { SourceArchiveSelector } from '../../types.ts';

export {
  ASSESSMENT_SOURCE_ARCHIVE_PREVIEW_BUDGET_CHARS,
  formatSourceArchiveIndex,
} from '@shared/sourceArchiveIndex';

import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';
import type { OpenRouterToolCall } from '../openrouter/types.ts';

export const SOURCE_ARCHIVE_ANALYSIS_TOOLS: Record<string, unknown>[] = [
  {
    type: 'function',
    function: {
      name: 'list_source_directory',
      description:
        'List the immediate files and directories under an exact source archive directory path. Use an empty path for the archive root.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_source_file',
      description:
        'Read one bounded UTF-8 page from an exact source archive file. Start with cursorBytes 0, then continue with each returned nextCursorBytes until it is null.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cursorBytes: { type: 'integer', minimum: 0 },
          path: { type: 'string', minLength: 1 },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_source_text',
      description:
        'Search every textual source file for an exact literal string and return matching paths and lines.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { query: { type: 'string', minLength: 1 } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_source_tree',
      description: 'Return the complete nested tree of the source archive.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  },
];

type ArchiveQuery =
  | { operation: 'list-directory'; path: string }
  | { cursorBytes?: number; operation: 'read-file'; path: string }
  | { operation: 'resolve-selectors'; selectors: SourceArchiveSelector[] }
  | { operation: 'search-text'; query: string }
  | { operation: 'tree' };

export interface SourceArchiveVersion {
  representationHash: string;
  sourceHash: string;
  sourceId: string;
}

interface ArchiveQueryResponse {
  error?: string;
  result?: unknown;
  success?: boolean;
}

const requireStringArgument = (
  args: Record<string, unknown>,
  name: 'path' | 'query',
  allowEmpty = false
): string => {
  const value = args[name];
  if (typeof value !== 'string' || (!allowEmpty && !value)) {
    throw new Error(`Argomento tool sorgente non valido: ${name}.`);
  }
  return value;
};

const parseToolArguments = (value: string): Record<string, unknown> => {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Argomenti tool sorgente non validi.');
  }
  return parsed as Record<string, unknown>;
};

const readOptionalCursor = (args: Record<string, unknown>): number | undefined => {
  const cursorBytes = args.cursorBytes;
  if (cursorBytes === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(cursorBytes) || (cursorBytes as number) < 0) {
    throw new Error('Argomento tool sorgente non valido: cursorBytes.');
  }
  return cursorBytes as number;
};

const buildToolQuery = (toolCall: OpenRouterToolCall): ArchiveQuery => {
  const args = parseToolArguments(toolCall.function.arguments);
  switch (toolCall.function.name) {
    case 'get_source_tree':
      return { operation: 'tree' };
    case 'list_source_directory':
      return {
        operation: 'list-directory',
        path: requireStringArgument(args, 'path', true),
      };
    case 'read_source_file': {
      const cursorBytes = readOptionalCursor(args);
      return {
        ...(cursorBytes === undefined ? {} : { cursorBytes }),
        operation: 'read-file',
        path: requireStringArgument(args, 'path'),
      };
    }
    case 'search_source_text':
      return {
        operation: 'search-text',
        query: requireStringArgument(args, 'query'),
      };
    default:
      throw new Error(`Operazione tool sorgente non supportata: ${toolCall.function.name}.`);
  }
};

export class SourceArchiveClient {
  private readonly baseUrl: string;

  constructor(baseUrl = getBackendUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
  }

  async resolveSelectors(
    projectId: string,
    archiveVersion: SourceArchiveVersion,
    selectors: SourceArchiveSelector[]
  ): Promise<Array<{ path: string; text: string }>> {
    return (await this.query(projectId, archiveVersion, {
      operation: 'resolve-selectors',
      selectors,
    })) as Array<{ path: string; text: string }>;
  }

  async runToolCall(
    projectId: string,
    archiveVersion: SourceArchiveVersion,
    toolCall: OpenRouterToolCall
  ): Promise<unknown> {
    return this.query(projectId, archiveVersion, buildToolQuery(toolCall));
  }

  private async query(
    projectId: string,
    archiveVersion: SourceArchiveVersion,
    query: ArchiveQuery
  ): Promise<unknown> {
    const response = await fetchWithSupabaseAuth(
      `${this.baseUrl}/api/projects/projects/${encodeURIComponent(projectId)}/source/archive/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...query, archiveVersion }),
      }
    );
    const payload = (await response.json()) as ArchiveQueryResponse;
    if (!response.ok || payload.success !== true) {
      throw new Error(payload.error || 'La sorgente archivio non è consultabile.');
    }
    return payload.result;
  }
}
