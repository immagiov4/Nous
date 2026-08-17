import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ProjectSourceArchiveVersion } from '../projects/types.js';
import type { ContextSourceArchiveSearchState } from './contextSourceArchiveSearch.js';

const SEARCH_CURSOR_VERSION = 1;

interface SearchCursorScope {
  archiveVersion: ProjectSourceArchiveVersion;
  projectId: string;
  query: string;
  userId: string;
}

interface SearchCursorPayload {
  state: ContextSourceArchiveSearchState;
  version: typeof SEARCH_CURSOR_VERSION;
}

const isSafeIntegerAtLeast = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

const readSearchState = (value: unknown): ContextSourceArchiveSearchState | null => {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (
    !isSafeIntegerAtLeast(state.carryByteLength, 0) ||
    !isSafeIntegerAtLeast(state.carryColumn, 1) ||
    !isSafeIntegerAtLeast(state.carryLine, 1) ||
    !isSafeIntegerAtLeast(state.column, 1) ||
    !isSafeIntegerAtLeast(state.cursorBytes, 0) ||
    !isSafeIntegerAtLeast(state.fileCursor, 0) ||
    !isSafeIntegerAtLeast(state.line, 1) ||
    typeof state.matchedPreviously !== 'boolean' ||
    typeof state.previousWasCarriageReturn !== 'boolean' ||
    !isSafeIntegerAtLeast(state.searchOffset, 0) ||
    state.carryByteLength > state.cursorBytes
  ) {
    return null;
  }
  return state as unknown as ContextSourceArchiveSearchState;
};

const buildScope = ({ archiveVersion, projectId, query, userId }: SearchCursorScope): string =>
  [
    userId,
    projectId,
    archiveVersion.sourceId,
    archiveVersion.sourceHash,
    archiveVersion.representationHash,
    query,
  ].join('\0');

const signPayload = (payload: string, scope: SearchCursorScope, signingSecret: string): Buffer =>
  createHmac('sha256', signingSecret)
    .update(buildScope(scope))
    .update('\0')
    .update(payload)
    .digest();

export const encodeContextSourceArchiveSearchCursor = ({
  scope,
  signingSecret,
  state,
}: {
  scope: SearchCursorScope;
  signingSecret: string;
  state: ContextSourceArchiveSearchState;
}): string => {
  const payload = Buffer.from(
    JSON.stringify({ state, version: SEARCH_CURSOR_VERSION } satisfies SearchCursorPayload)
  ).toString('base64url');
  const signature = signPayload(payload, scope, signingSecret).toString('base64url');
  return `${payload}.${signature}`;
};

export const decodeContextSourceArchiveSearchCursor = ({
  cursor,
  scope,
  signingSecret,
}: {
  cursor: string;
  scope: SearchCursorScope;
  signingSecret: string;
}): ContextSourceArchiveSearchState | null => {
  const [payload, encodedSignature, extra] = cursor.split('.');
  if (!payload || !encodedSignature || extra) return null;

  const expectedSignature = signPayload(payload, scope, signingSecret);
  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return null;
  }
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      state?: unknown;
      version?: unknown;
    };
    if (decoded.version !== SEARCH_CURSOR_VERSION) return null;
    return readSearchState(decoded.state);
  } catch {
    return null;
  }
};
