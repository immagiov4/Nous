import type {
  SourceArchiveAccess,
  SourceArchiveIndexedFile,
  SourceArchiveSearchMatch,
} from '../projects/sourceArchiveAccess.js';

interface SearchPosition {
  column: number;
  line: number;
  previousWasCarriageReturn: boolean;
}

const HIGH_SURROGATE_PATTERN = /[\uD800-\uDBFF]/u;
const LOW_SURROGATE_PATTERN = /[\uDC00-\uDFFF]/u;

export interface ContextSourceArchiveSearchState {
  carryByteLength: number;
  carryColumn: number;
  carryLine: number;
  column: number;
  cursorBytes: number;
  fileCursor: number;
  line: number;
  matchedPreviously: boolean;
  previousWasCarriageReturn: boolean;
  searchOffset: number;
}

export interface ContextSourceArchiveSearchCandidate {
  match: Omit<SourceArchiveSearchMatch, 'lineText'> & { cursorBytes: number };
  retryState: ContextSourceArchiveSearchState;
  resumeState: ContextSourceArchiveSearchState;
}

export interface ContextSourceArchiveSearchPage {
  candidates: ContextSourceArchiveSearchCandidate[];
  nextState: ContextSourceArchiveSearchState | null;
}

const INITIAL_SEARCH_STATE: ContextSourceArchiveSearchState = {
  carryByteLength: 0,
  carryColumn: 1,
  carryLine: 1,
  column: 1,
  cursorBytes: 0,
  fileCursor: 0,
  line: 1,
  matchedPreviously: false,
  previousWasCarriageReturn: false,
  searchOffset: 0,
};

const advancePosition = (
  text: string,
  start: number,
  end: number,
  initial: SearchPosition
): SearchPosition => {
  let { column, line, previousWasCarriageReturn } = initial;
  for (let index = start; index < end; index += 1) {
    const character = text[index];
    if (character === '\r') {
      line += 1;
      column = 1;
      previousWasCarriageReturn = true;
      continue;
    }
    if (character === '\n') {
      if (!previousWasCarriageReturn) line += 1;
      column = 1;
      previousWasCarriageReturn = false;
      continue;
    }
    column += 1;
    previousWasCarriageReturn = false;
  }
  return { column, line, previousWasCarriageReturn };
};

const getTextFiles = (access: SourceArchiveAccess): SourceArchiveIndexedFile[] =>
  [...access.iterateEntries()].filter(
    (entry): entry is SourceArchiveIndexedFile =>
      entry.kind === 'file' && entry.contentKind === 'text'
  );

const nextFileState = (
  fileCursor: number,
  matchedPreviously: boolean
): ContextSourceArchiveSearchState => ({
  ...INITIAL_SEARCH_STATE,
  fileCursor,
  matchedPreviously,
});

const buildNextPageState = ({
  combinedText,
  endPosition,
  fileCursor,
  nextCursorBytes,
  query,
  startPosition,
  matchedPreviously,
  textFileCount,
}: {
  combinedText: string;
  endPosition: SearchPosition;
  fileCursor: number;
  nextCursorBytes: number | null;
  query: string;
  startPosition: SearchPosition;
  matchedPreviously: boolean;
  textFileCount: number;
}): ContextSourceArchiveSearchState | null => {
  if (nextCursorBytes === null) {
    return fileCursor + 1 < textFileCount ? nextFileState(fileCursor + 1, matchedPreviously) : null;
  }

  const lastLineBreak = Math.max(combinedText.lastIndexOf('\n'), combinedText.lastIndexOf('\r'));
  const currentLineStart = lastLineBreak + 1;
  const carryLength = Math.min(query.length - 1, combinedText.length - currentLineStart);
  let carryStart = combinedText.length - carryLength;
  if (
    carryStart > currentLineStart &&
    LOW_SURROGATE_PATTERN.test(combinedText[carryStart] || '') &&
    HIGH_SURROGATE_PATTERN.test(combinedText[carryStart - 1] || '')
  ) {
    carryStart -= 1;
  }
  const carryPosition = advancePosition(combinedText, 0, carryStart, startPosition);
  return {
    carryByteLength: new TextEncoder().encode(combinedText.slice(carryStart)).byteLength,
    carryColumn: carryPosition.column,
    carryLine: carryPosition.line,
    column: endPosition.column,
    cursorBytes: nextCursorBytes,
    fileCursor,
    line: endPosition.line,
    matchedPreviously,
    previousWasCarriageReturn: endPosition.previousWasCarriageReturn,
    searchOffset: 0,
  };
};

const findCandidates = ({
  combinedText,
  filePath,
  query,
  state,
  startPosition,
  carryText,
}: {
  carryText: string;
  combinedText: string;
  filePath: string;
  query: string;
  state: ContextSourceArchiveSearchState;
  startPosition: SearchPosition;
}): ContextSourceArchiveSearchCandidate[] => {
  const candidates: ContextSourceArchiveSearchCandidate[] = [];
  const encoder = new TextEncoder();
  let byteOffset = state.cursorBytes - state.carryByteLength;
  let bytePositionOffset = 0;
  let position = startPosition;
  let positionOffset = 0;
  let matchOffset = combinedText.indexOf(query, state.searchOffset);
  while (matchOffset !== -1) {
    byteOffset += encoder.encode(combinedText.slice(bytePositionOffset, matchOffset)).byteLength;
    bytePositionOffset = matchOffset;
    position = advancePosition(combinedText, positionOffset, matchOffset, position);
    positionOffset = matchOffset;
    if (matchOffset + query.length > carryText.length) {
      candidates.push({
        match: {
          column: position.column,
          cursorBytes: byteOffset,
          line: position.line,
          path: filePath,
        },
        retryState: { ...state, searchOffset: matchOffset },
        resumeState: { ...state, matchedPreviously: true, searchOffset: matchOffset + 1 },
      });
    }
    matchOffset = combinedText.indexOf(query, matchOffset + 1);
  }
  return candidates;
};

export const searchContextSourceArchivePage = async ({
  access,
  maxPageBytes,
  query,
  state = INITIAL_SEARCH_STATE,
}: {
  access: SourceArchiveAccess;
  maxPageBytes: number;
  query: string;
  state?: ContextSourceArchiveSearchState;
}): Promise<ContextSourceArchiveSearchPage> => {
  const textFiles = getTextFiles(access);
  let currentState = state;
  while (
    currentState.fileCursor < textFiles.length &&
    textFiles[currentState.fileCursor]?.byteSize === 0
  ) {
    currentState = nextFileState(currentState.fileCursor + 1, currentState.matchedPreviously);
  }
  const file = textFiles[currentState.fileCursor];
  if (!file) return { candidates: [], nextState: null };

  const carryPage = currentState.carryByteLength
    ? await access.readTextPage(
        file.path,
        currentState.cursorBytes - currentState.carryByteLength,
        currentState.carryByteLength
      )
    : null;
  const carryText = carryPage?.text || '';
  const page = await access.readTextPage(file.path, currentState.cursorBytes, maxPageBytes);
  const combinedText = carryText + page.text;
  const startPosition = carryText
    ? {
        column: currentState.carryColumn,
        line: currentState.carryLine,
        previousWasCarriageReturn: false,
      }
    : {
        column: currentState.column,
        line: currentState.line,
        previousWasCarriageReturn: currentState.previousWasCarriageReturn,
      };
  const endPosition = advancePosition(combinedText, 0, combinedText.length, startPosition);

  return {
    candidates: findCandidates({
      combinedText,
      carryText,
      filePath: file.path,
      query,
      state: currentState,
      startPosition,
    }),
    nextState: buildNextPageState({
      combinedText,
      endPosition,
      fileCursor: currentState.fileCursor,
      nextCursorBytes: page.nextCursorBytes,
      query,
      startPosition,
      matchedPreviously: currentState.matchedPreviously,
      textFileCount: textFiles.length,
    }),
  };
};
