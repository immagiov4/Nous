import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_FULL_MEDIA_TYPE = 'application/vnd.github.full+json';
const GITHUB_BODY_RESOURCES = Object.freeze({ issue: 'issues', pr: 'pulls' });
const GITHUB_BODY_KIND_USAGE = Object.keys(GITHUB_BODY_RESOURCES)
  .toSorted((left, right) => left.localeCompare(right))
  .join('|');
const HEADING_PATTERN = /^( {0,3})(#{1,6})(?:[ \t]+|$)/u;
const LIST_ITEM_PATTERN = /^( {0,3})(?:[-+*]|\d{1,9}[.)])(?:[ \t]+\S|[ \t]*$)/u;
const PARAGRAPH_INTERRUPT_LIST_PATTERN = /^( {0,3})(?:[-+*]|1[.)])(?:[ \t]+\S|[ \t]*$)/u;
// A single # in prose is indistinguishable from a flattened H1; H2+ matches the repository's PR sections without rejecting normal prose.
const INLINE_HEADING_PATTERN = /\S[ \t]+#{2,6}(?:[ \t]+\S|[ \t]*$)/u;
const INLINE_TASK_ITEM_PATTERN = /\S[ \t]+(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]+\S/u;
const LITERAL_NEWLINE_PATTERN = /\\(?:r\\n|n)/u;
const MANAGED_PR_SUFFIX_PATTERN =
  /(?:\r?\n){2}<!-- This is an auto-generated description by cubic\. -->[\s\S]*$/u;
const BLOCKQUOTE_PREFIX_PATTERN = /^(?: {0,3}>[ \t]?)+/u;
const INDENTED_CODE_PATTERN = /^(?: {4,}|\t)\S/u;
const RAW_HTML_TAG_START_PATTERN = /^ {0,3}<(\/)?([A-Za-z][A-Za-z0-9-]*)(?=[ \t/>]|$)/u;
const RAW_HTML_CLOSING_TAG_PATTERN = /^ {0,3}<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/u;
const HTML_ATTRIBUTE_NAME_START_PATTERN = /^[A-Za-z_:]$/u;
const HTML_ATTRIBUTE_NAME_CHARACTER_PATTERN = /^[A-Za-z0-9_.:-]$/u;
const HTML_UNQUOTED_ATTRIBUTE_CHARACTER_PATTERN = /^[^ \t\n\f\r/"'`<>=]$/u;
const RAW_HTML_BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'base',
  'basefont',
  'blockquote',
  'body',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'frame',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'iframe',
  'legend',
  'li',
  'link',
  'main',
  'menu',
  'menuitem',
  'nav',
  'noframes',
  'ol',
  'optgroup',
  'option',
  'p',
  'param',
  'search',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'track',
  'tr',
  'ul',
]);
const RAW_HTML_UNINTERRUPTED_TAGS = new Set(['pre', 'script', 'style', 'textarea']);
const WINDOWS_PATH_TOKEN_PATTERN = /[^\s<>()[\]{}"`]+/gu;
const LITERAL_NEWLINE_CANDIDATE_PATTERN = /\\(?:r\\n|n)/gu;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SETEXT_HEADING_PATTERN = /^ {0,3}(=+|-+)[ \t]*$/u;
const TABLE_DELIMITER_CELL_PATTERN = /^:?-+:?$/u;

const normalizeLineEndings = body => body.replace(/\r\n?/gu, '\n');
const markdownBlockContent = line => {
  const leadingSpaces = /^ */u.exec(line)?.[0].length ?? 0;
  if (leadingSpaces > 3 || line[leadingSpaces] === '\t') return undefined;
  return line.slice(leadingSpaces);
};

const isThematicBreak = line => {
  const content = markdownBlockContent(line);
  if (content === undefined) return false;
  const compactMarker = content.replace(/[ \t]/gu, '');
  if (compactMarker.length < 3) return false;
  return ['*', '-', '_'].some(marker => compactMarker === marker.repeat(compactMarker.length));
};

const isTableDelimiter = line => {
  const content = markdownBlockContent(line);
  if (content === undefined) return false;
  const trimmedLine = content.trimEnd();
  if (!trimmedLine.includes('|')) return false;
  const cells = trimmedLine.replace(/^\|/u, '').replace(/\|$/u, '').split('|');
  return cells.length > 1 && cells.every(cell => TABLE_DELIMITER_CELL_PATTERN.test(cell.trim()));
};

const isTopLevelListItem = line => LIST_ITEM_PATTERN.test(line) && !isThematicBreak(line);
const isParagraphInterruptingListItem = line =>
  PARAGRAPH_INTERRUPT_LIST_PATTERN.test(line) && !isThematicBreak(line);
const stripBlockquotePrefix = line => line.replace(BLOCKQUOTE_PREFIX_PATTERN, '');
const stripBlockquotePrefixes = body =>
  normalizeLineEndings(body).split('\n').map(stripBlockquotePrefix).join('\n');

const leavesParagraphOpen = (line, hasRenderedInlineContent = false) => {
  if (!line.trim()) return hasRenderedInlineContent;
  return !(
    HEADING_PATTERN.test(line) ||
    isTopLevelListItem(line) ||
    SETEXT_HEADING_PATTERN.test(line) ||
    isTableDelimiter(line) ||
    isThematicBreak(line) ||
    Boolean(linkDefinitionPrefix(line))
  );
};

const maskRange = (characters, start, end) => {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\n') characters[index] = ' ';
  }
};

const markerRunLength = (line, start, marker) => {
  let end = start;
  while (line[end] === marker) end += 1;
  return end - start;
};

const rawHtmlClosingPattern = tag => new RegExp(String.raw`</${tag}[ \t]*>`, 'iu');

const specialRawHtmlBlock = line => {
  const content = markdownBlockContent(line);
  if (content === undefined) return undefined;
  if (content.startsWith('<?')) return { closingMarker: '?>', rendersContent: false };
  if (content.startsWith('<![CDATA[')) return { closingMarker: ']]>', rendersContent: false };
  if (/^<![A-Z]/u.test(content)) return { closingMarker: '>', rendersContent: false };
  return undefined;
};

const skipHtmlWhitespace = (value, start) => {
  let cursor = start;
  while (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
  return cursor;
};

const trimTrailingHtmlWhitespace = value => {
  let end = value.length;
  while (value[end - 1] === ' ' || value[end - 1] === '\t') end -= 1;
  return value.slice(0, end);
};

const htmlAttributeValueEnd = (value, start) => {
  const quote = value[start];
  if (quote === '"' || quote === "'") {
    const closingQuote = value.indexOf(quote, start + 1);
    return closingQuote === -1 ? -1 : closingQuote + 1;
  }

  let cursor = start;
  while (HTML_UNQUOTED_ATTRIBUTE_CHARACTER_PATTERN.test(value[cursor] ?? '')) cursor += 1;
  return cursor === start ? -1 : cursor;
};

const htmlAttributeEnd = (value, start) => {
  if (!HTML_ATTRIBUTE_NAME_START_PATTERN.test(value[start] ?? '')) return -1;
  let cursor = start + 1;
  while (HTML_ATTRIBUTE_NAME_CHARACTER_PATTERN.test(value[cursor] ?? '')) cursor += 1;

  const equalsSign = skipHtmlWhitespace(value, cursor);
  if (value[equalsSign] !== '=') return cursor;
  const attributeValue = skipHtmlWhitespace(value, equalsSign + 1);
  return htmlAttributeValueEnd(value, attributeValue);
};

const isCompleteRawHtmlOpeningTag = line => {
  const blockContent = markdownBlockContent(line);
  const value = blockContent === undefined ? undefined : trimTrailingHtmlWhitespace(blockContent);
  if (!value?.startsWith('<') || value.startsWith('</')) return false;

  let cursor = 1;
  if (!/^[A-Za-z]$/u.test(value[cursor] ?? '')) return false;
  cursor += 1;
  while (/^[A-Za-z0-9-]$/u.test(value[cursor] ?? '')) cursor += 1;

  while (cursor < value.length) {
    const attributeStart = skipHtmlWhitespace(value, cursor);
    if (value[attributeStart] === '>' && attributeStart === value.length - 1) return true;
    if (value[attributeStart] === '/' && value.slice(attributeStart) === '/>') return true;
    if (attributeStart === cursor) return false;
    cursor = htmlAttributeEnd(value, attributeStart);
    if (cursor === -1) return false;
  }
  return false;
};

const isCompleteRawHtmlTagLine = line => {
  if (RAW_HTML_CLOSING_TAG_PATTERN.test(line)) return true;
  return isCompleteRawHtmlOpeningTag(line);
};

const isWindowsPathToken = token => {
  if (/^(?:[A-Za-z]:\\|\\\\)/u.test(token)) return true;
  const separatorCount = token.match(/\\/gu)?.length ?? 0;
  return separatorCount >= 2 && /\\(?!n|r\\n)/u.test(token);
};

const structuralLiteralNewlineIndex = token => {
  for (const match of token.matchAll(LITERAL_NEWLINE_CANDIDATE_PATTERN)) {
    const suffix = token.slice(match.index + match[0].length);
    if (HEADING_PATTERN.test(suffix) || LIST_ITEM_PATTERN.test(suffix)) return match.index;
  }
  return -1;
};

const maskWindowsPathTokens = line =>
  line.replace(WINDOWS_PATH_TOKEN_PATTERN, token => {
    if (!isWindowsPathToken(token)) return token;
    const separatorIndex = structuralLiteralNewlineIndex(token);
    if (separatorIndex === -1) return ' '.repeat(token.length);
    return ' '.repeat(separatorIndex) + token.slice(separatorIndex);
  });

const openRawHtmlBlock = (line, state, canStartTypeSeven) => {
  const specialBlock = specialRawHtmlBlock(line);
  if (specialBlock) {
    if (!line.includes(specialBlock.closingMarker)) {
      state.rawHtmlBlock = { endsAtBlank: false, ...specialBlock };
    }
    return { rendersContent: specialBlock.rendersContent };
  }

  const openingTag = RAW_HTML_TAG_START_PATTERN.exec(line);
  if (!openingTag) return false;
  const tag = openingTag[2].toLowerCase();
  if (RAW_HTML_BLOCK_TAGS.has(tag)) {
    state.rawHtmlBlock = { endsAtBlank: true, rendersContent: true, tag };
    return { rendersContent: true };
  }
  if (!openingTag[1] && RAW_HTML_UNINTERRUPTED_TAGS.has(tag)) {
    if (!rawHtmlClosingPattern(tag).test(line)) {
      state.rawHtmlBlock = { endsAtBlank: false, rendersContent: true, tag };
    }
    return { rendersContent: true };
  }
  if (canStartTypeSeven && isCompleteRawHtmlTagLine(line)) {
    state.rawHtmlBlock = { endsAtBlank: true, rendersContent: true, tag };
    return { rendersContent: true };
  }
  return false;
};

const continueRawHtmlBlock = (line, state) => {
  if (!state.rawHtmlBlock) return undefined;
  if (!line.trim() && state.rawHtmlBlock.endsAtBlank) {
    state.rawHtmlBlock = undefined;
    return undefined;
  }

  const isClosingLine =
    !state.rawHtmlBlock.endsAtBlank &&
    (state.rawHtmlBlock.closingMarker
      ? line.includes(state.rawHtmlBlock.closingMarker)
      : rawHtmlClosingPattern(state.rawHtmlBlock.tag).test(line));
  const rendersContent = state.rawHtmlBlock.rendersContent;
  if (isClosingLine) state.rawHtmlBlock = undefined;
  state.paragraphOpen = false;
  return { isClosingLine, kind: 'raw-html', rendersContent };
};

const isClosingFence = (line, fence) => {
  const content = markdownBlockContent(line);
  if (content === undefined) return false;
  const markerLength = markerRunLength(content, 0, fence.character);
  return markerLength >= fence.length && !content.slice(markerLength).trim();
};

const continueFencedCodeBlock = (line, state) => {
  if (!state.fence) return undefined;
  const isClosingLine = isClosingFence(line, state.fence);
  if (isClosingLine) state.fence = undefined;
  state.paragraphOpen = false;
  return { isClosingLine, isOpeningLine: false, kind: 'fenced-code' };
};

const advanceBlockState = (line, state) => {
  const rawHtmlBlock = continueRawHtmlBlock(line, state);
  if (rawHtmlBlock) return rawHtmlBlock;

  const fencedCodeBlock = continueFencedCodeBlock(line, state);
  if (fencedCodeBlock) return fencedCodeBlock;

  const openingFence = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  if (openingFence) {
    const marker = openingFence[1];
    const infoString = line.slice((openingFence.index ?? 0) + marker.length);
    if (marker[0] !== '`' || !infoString.includes('`')) {
      state.fence = { character: marker[0], length: marker.length };
      state.paragraphOpen = false;
      return { isClosingLine: false, isOpeningLine: true, kind: 'fenced-code' };
    }
  }

  if (!line.trim()) {
    state.paragraphOpen = false;
    return { kind: 'blank' };
  }

  if (!state.paragraphOpen && INDENTED_CODE_PATTERN.test(line)) {
    state.paragraphOpen = false;
    return { kind: 'indented-code' };
  }

  const openedRawHtmlBlock = openRawHtmlBlock(line, state, !state.paragraphOpen);
  if (openedRawHtmlBlock) {
    state.paragraphOpen = false;
    return { isClosingLine: false, kind: 'raw-html', ...openedRawHtmlBlock };
  }

  return { kind: 'content' };
};

const inlineRunKey = (lineIndex, column) => `${lineIndex}:${column}`;

const isMarkdownEscaped = (value, index) => {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
};

const collectRawInlineCodeOpeners = lines => {
  const openers = new Set();
  const state = { fence: undefined, paragraphOpen: false, rawHtmlBlock: undefined };
  let blockRuns = [];

  const recordBlockOpeners = () => {
    let openerIndex = 0;
    while (openerIndex < blockRuns.length) {
      const openingRun = blockRuns[openerIndex];
      if (openingRun.escaped) {
        openerIndex += 1;
        continue;
      }
      let closingIndex = openerIndex + 1;
      while (
        closingIndex < blockRuns.length &&
        blockRuns[closingIndex].length !== openingRun.length
      ) {
        closingIndex += 1;
      }
      if (closingIndex === blockRuns.length) {
        openerIndex += 1;
        continue;
      }
      openers.add(openingRun.key);
      openerIndex = closingIndex + 1;
    }
    blockRuns = [];
  };

  for (const [lineIndex, line] of lines.entries()) {
    const block = advanceBlockState(line, state);
    if (block.kind !== 'content') {
      recordBlockOpeners();
      continue;
    }
    for (const run of line.matchAll(/`+/gu)) {
      blockRuns.push({
        key: inlineRunKey(lineIndex, run.index),
        length: run[0].length,
        escaped: isMarkdownEscaped(line, run.index),
      });
    }
    state.paragraphOpen = leavesParagraphOpen(line, /`/u.test(line));
    if (!state.paragraphOpen) recordBlockOpeners();
  }
  recordBlockOpeners();
  return openers;
};

const findNextInlineCodeOpener = (line, lineIndex, cursor, openers) => {
  let delimiterStart = line.indexOf('`', cursor);
  while (delimiterStart !== -1) {
    if (openers.has(inlineRunKey(lineIndex, delimiterStart))) return delimiterStart;
    delimiterStart = line.indexOf('`', delimiterStart + markerRunLength(line, delimiterStart, '`'));
  }
  return -1;
};

const maskActiveHtmlComment = (line, cursor, characters, state) => {
  const commentEnd = line.indexOf('-->', cursor);
  const maskEnd = commentEnd === -1 ? line.length : commentEnd + 3;
  maskRange(characters, cursor, maskEnd);
  state.inHtmlComment = commentEnd === -1;
  return maskEnd;
};

const maskActiveInlineCode = (line, cursor, characters, state) => {
  const delimiterStart = line.indexOf('`', cursor);
  if (delimiterStart === -1) {
    maskRange(characters, cursor, line.length);
    return line.length;
  }
  const delimiterLength = markerRunLength(line, delimiterStart, '`');
  const maskEnd = delimiterStart + delimiterLength;
  maskRange(characters, cursor, maskEnd);
  if (delimiterLength === state.inlineCodeDelimiter) state.inlineCodeDelimiter = undefined;
  return maskEnd;
};

const maskNewInlineCode = (line, start, characters, renderedContentLines, lineIndex, state) => {
  const delimiterLength = markerRunLength(line, start, '`');
  const delimiterEnd = start + delimiterLength;
  maskRange(characters, start, delimiterEnd);
  renderedContentLines.add(lineIndex);
  state.inlineCodeDelimiter = delimiterLength;
  return delimiterEnd;
};

const maskInlineCodeAndHtmlComments = (line, lineIndex, openers, renderedContentLines, state) => {
  const characters = line.split('');
  let cursor = 0;

  while (cursor < line.length) {
    if (state.inHtmlComment) {
      cursor = maskActiveHtmlComment(line, cursor, characters, state);
      continue;
    }

    if (state.inlineCodeDelimiter) {
      if (line.trim()) renderedContentLines.add(lineIndex);
      cursor = maskActiveInlineCode(line, cursor, characters, state);
      continue;
    }

    const commentStart = line.indexOf('<!--', cursor);
    const inlineCodeStart = findNextInlineCodeOpener(line, lineIndex, cursor, openers);
    if (inlineCodeStart !== -1 && (commentStart === -1 || inlineCodeStart < commentStart)) {
      cursor = maskNewInlineCode(
        line,
        inlineCodeStart,
        characters,
        renderedContentLines,
        lineIndex,
        state
      );
      continue;
    }
    if (commentStart === -1) break;
    cursor = maskActiveHtmlComment(line, commentStart, characters, state);
  }

  return characters.join('');
};

const sameLineCodeSpanEnd = (line, markerIndex) => {
  const runs = [...line.matchAll(/`+/gu)];
  let openerIndex = 0;
  while (openerIndex < runs.length) {
    const openingRun = runs[openerIndex];
    const closingIndex = runs.findIndex(
      (run, index) => index > openerIndex && run[0].length === openingRun[0].length
    );
    if (closingIndex === -1) {
      openerIndex += 1;
      continue;
    }
    const closingRun = runs[closingIndex];
    if (openingRun.index < markerIndex && closingRun.index > markerIndex) {
      return closingRun.index + closingRun[0].length;
    }
    openerIndex = closingIndex + 1;
  }
  return -1;
};

const advanceCollectionInlineCode = (line, cursor, state) => {
  const delimiterStart = line.indexOf('`', cursor);
  if (delimiterStart === -1) return line.length;
  const delimiterLength = markerRunLength(line, delimiterStart, '`');
  if (delimiterLength === state.inlineCodeDelimiter) state.inlineCodeDelimiter = undefined;
  return delimiterStart + delimiterLength;
};

const maskCollectionComment = ({
  characters,
  line,
  lineIndex,
  lines,
  maskUnclosedComments,
  start,
  state,
}) => {
  const commentEnd = line.indexOf('-->', start + 4);
  if (commentEnd !== -1) {
    maskRange(characters, start, commentEnd + 3);
    return commentEnd + 3;
  }

  const closesLater = lines.slice(lineIndex + 1).some(candidate => candidate.includes('-->'));
  if (!maskUnclosedComments && !closesLater) return line.length;
  maskRange(characters, start, line.length);
  state.inHtmlComment = true;
  return line.length;
};

const maskCommentsOnCollectionLine = ({
  line,
  lineIndex,
  lines,
  maskUnclosedComments,
  preliminaryOpeners,
  state,
}) => {
  const characters = line.split('');
  let cursor = 0;

  while (cursor < line.length) {
    if (state.inHtmlComment) {
      cursor = maskActiveHtmlComment(line, cursor, characters, state);
      continue;
    }
    if (state.inlineCodeDelimiter) {
      cursor = advanceCollectionInlineCode(line, cursor, state);
      continue;
    }

    const commentStart = line.indexOf('<!--', cursor);
    const inlineCodeStart = findNextInlineCodeOpener(line, lineIndex, cursor, preliminaryOpeners);
    if (inlineCodeStart !== -1 && (commentStart === -1 || inlineCodeStart < commentStart)) {
      state.inlineCodeDelimiter = markerRunLength(line, inlineCodeStart, '`');
      cursor = inlineCodeStart + state.inlineCodeDelimiter;
      continue;
    }
    if (commentStart === -1) break;

    const codeSpanEnd = sameLineCodeSpanEnd(characters.join(''), commentStart);
    cursor =
      codeSpanEnd === -1
        ? maskCollectionComment({
            characters,
            line,
            lineIndex,
            lines,
            maskUnclosedComments,
            start: commentStart,
            state,
          })
        : codeSpanEnd;
  }

  const commentMaskedLine = characters.join('');
  state.paragraphOpen = leavesParagraphOpen(commentMaskedLine, /`/u.test(commentMaskedLine));
  return commentMaskedLine;
};

const maskHtmlCommentsForOpenerCollection = (
  lines,
  preliminaryOpeners,
  maskUnclosedComments = true
) => {
  const state = {
    fence: undefined,
    inHtmlComment: false,
    inlineCodeDelimiter: undefined,
    paragraphOpen: false,
    rawHtmlBlock: undefined,
  };
  const maskedLines = [];

  for (const [lineIndex, line] of lines.entries()) {
    if (!state.inHtmlComment && !state.inlineCodeDelimiter) {
      const block = advanceBlockState(line, state);
      if (block.kind !== 'content') {
        maskedLines.push(line);
        continue;
      }
    }
    maskedLines.push(
      maskCommentsOnCollectionLine({
        line,
        lineIndex,
        lines,
        maskUnclosedComments,
        preliminaryOpeners,
        state,
      })
    );
  }
  return maskedLines;
};

const collectInlineCodeOpeners = lines => {
  const rawOpeners = collectRawInlineCodeOpeners(lines);
  const closedCommentMaskedLines = maskHtmlCommentsForOpenerCollection(lines, rawOpeners, false);
  const preliminaryOpeners = collectRawInlineCodeOpeners(closedCommentMaskedLines);
  const commentMaskedLines = maskHtmlCommentsForOpenerCollection(lines, preliminaryOpeners);
  return collectRawInlineCodeOpeners(commentMaskedLines);
};

const maskNonRenderedMarkdown = (body, renderedContentLines = new Set()) => {
  const state = {
    fence: undefined,
    inHtmlComment: false,
    inlineCodeDelimiter: undefined,
    paragraphOpen: false,
    rawHtmlBlock: undefined,
  };
  const lines = normalizeLineEndings(body).split('\n');
  const inlineCodeOpeners = collectInlineCodeOpeners(lines);

  return lines.map((line, lineIndex) => {
    if (state.inHtmlComment || state.inlineCodeDelimiter) {
      return maskInlineCodeAndHtmlComments(
        line,
        lineIndex,
        inlineCodeOpeners,
        renderedContentLines,
        state
      );
    }

    const block = advanceBlockState(line, state);
    if (block.kind === 'raw-html') {
      if (block.rendersContent && line.trim() && !block.isClosingLine) {
        renderedContentLines.add(lineIndex);
      }
      return ' '.repeat(line.length);
    }
    if (block.kind === 'fenced-code') {
      if (block.isOpeningLine || (line.trim() && !block.isClosingLine)) {
        renderedContentLines.add(lineIndex);
      }
      return ' '.repeat(line.length);
    }
    if (block.kind === 'indented-code') {
      renderedContentLines.add(lineIndex);
      return ' '.repeat(line.length);
    }
    if (block.kind === 'blank') {
      return ' '.repeat(line.length);
    }

    const maskedLine = maskInlineCodeAndHtmlComments(
      line,
      lineIndex,
      inlineCodeOpeners,
      renderedContentLines,
      state
    );
    state.paragraphOpen = leavesParagraphOpen(maskedLine, renderedContentLines.has(lineIndex));
    return maskedLine;
  });
};

const issue = (code, line, message) => ({ code, line, message });
const COMMONMARK_ESCAPABLE_PUNCTUATION = new Set([
  ...String.raw`!"#$%&'()*+,-./:;<=>?@[\]^_\`{|}~`,
]);
const isEscapableMarkdownPunctuation = character => COMMONMARK_ESCAPABLE_PUNCTUATION.has(character);

const normalizedLinkIdentifier = identifier =>
  identifier
    .replace(/\\(.)/gu, (escapedPair, character) =>
      isEscapableMarkdownPunctuation(character) ? character : escapedPair
    )
    .trim()
    .replace(/[ \t\n]+/gu, ' ')
    .toLowerCase();

const closingDelimiterIndex = (value, start, opening, closing) => {
  let depth = 0;
  for (let cursor = start; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\' && isEscapableMarkdownPunctuation(value[cursor + 1])) {
      cursor += 1;
      continue;
    }
    if (value[cursor] === opening) depth += 1;
    if (value[cursor] !== closing) continue;
    depth -= 1;
    if (depth === 0) return cursor;
  }
  return -1;
};

const markdownTitleEnd = (value, start) => {
  const delimiter = value[start];
  if (delimiter === '(') {
    const end = closingDelimiterIndex(value, start, '(', ')');
    return end === -1 ? -1 : end + 1;
  }
  if (delimiter !== '"' && delimiter !== "'") return -1;
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\' && isEscapableMarkdownPunctuation(value[cursor + 1])) {
      cursor += 1;
      continue;
    }
    if (value[cursor] === delimiter) return cursor + 1;
  }
  return -1;
};

const skipMarkdownWhitespace = (value, start) => {
  let cursor = start;
  while (/[\t\n ]/u.test(value[cursor] ?? '')) cursor += 1;
  return cursor;
};

const markdownDestinationEnd = (value, start, stopAtOuterParenthesis) => {
  if (value[start] === '<') {
    for (let cursor = start + 1; cursor < value.length; cursor += 1) {
      if (value[cursor] === '\\' && isEscapableMarkdownPunctuation(value[cursor + 1])) {
        cursor += 1;
        continue;
      }
      if (value[cursor] === '>') return cursor + 1;
      if (value[cursor] === '<' || /[\t\n\r ]/u.test(value[cursor])) return -1;
    }
    return -1;
  }

  let depth = 0;
  let cursor = start;
  while (cursor < value.length && !/[\t\n\r ]/u.test(value[cursor])) {
    if (value[cursor] === '\\' && isEscapableMarkdownPunctuation(value[cursor + 1])) {
      cursor += 2;
      continue;
    }
    if (value[cursor] === '(') depth += 1;
    if (value[cursor] === ')') {
      if (depth === 0) return stopAtOuterParenthesis ? cursor : -1;
      depth -= 1;
    }
    cursor += 1;
  }
  return cursor === start || depth !== 0 ? -1 : cursor;
};

const parseDestinationAndTitle = (value, start, outerParenthesis) => {
  let cursor = skipMarkdownWhitespace(value, start);
  if (outerParenthesis && value[cursor] === ')') {
    return { end: cursor + 1, hasTitle: false };
  }
  const destinationEnd = markdownDestinationEnd(value, cursor, outerParenthesis);
  if (destinationEnd === -1) return undefined;
  cursor = destinationEnd;
  if (outerParenthesis && value[cursor] === ')') {
    return { end: cursor + 1, hasTitle: false };
  }
  if (!outerParenthesis && cursor === value.length) {
    return { end: cursor, hasTitle: false };
  }

  const titleStart = skipMarkdownWhitespace(value, cursor);
  if (titleStart === cursor) return undefined;
  if (outerParenthesis && value[titleStart] === ')') {
    return { end: titleStart + 1, hasTitle: false };
  }
  if (!outerParenthesis && titleStart === value.length) {
    return { end: titleStart, hasTitle: false };
  }
  const titleEnd = markdownTitleEnd(value, titleStart);
  if (titleEnd === -1) return undefined;
  cursor = skipMarkdownWhitespace(value, titleEnd);
  if (outerParenthesis) {
    return value[cursor] === ')' ? { end: cursor + 1, hasTitle: true } : undefined;
  }
  return cursor === value.length ? { end: cursor, hasTitle: true } : undefined;
};

function linkDefinitionPrefix(line) {
  const content = markdownBlockContent(line);
  if (!content?.startsWith('[')) return undefined;
  const labelEnd = closingDelimiterIndex(content, 0, '[', ']');
  if (labelEnd <= 1 || content[labelEnd + 1] !== ':') return undefined;
  return { content, destinationStart: labelEnd + 2, identifier: content.slice(1, labelEnd) };
}

const parseTitleOnlyLine = line => {
  if (!/^ {1,3}\S/u.test(line)) return false;
  const content = markdownBlockContent(line);
  if (content === undefined) return false;
  const titleEnd = markdownTitleEnd(content, 0);
  return titleEnd !== -1 && skipHtmlWhitespace(content, titleEnd) === content.length;
};

function parseLinkDefinitionAt(lines, index) {
  const prefix = linkDefinitionPrefix(lines[index] ?? '');
  if (!prefix) return undefined;
  let parsed = parseDestinationAndTitle(prefix.content, prefix.destinationStart, false);
  let nextIndex = index + 1;
  if (!parsed) {
    if (prefix.content.slice(prefix.destinationStart).trim()) return undefined;
    const destinationLine = lines[index + 1] ?? '';
    if (!/^ {1,3}\S/u.test(destinationLine)) return undefined;
    const destinationContent = markdownBlockContent(destinationLine);
    if (destinationContent === undefined) return undefined;
    parsed = parseDestinationAndTitle(destinationContent, 0, false);
    if (!parsed) return undefined;
    nextIndex += 1;
  }
  if (!parsed.hasTitle && parseTitleOnlyLine(lines[nextIndex] ?? '')) nextIndex += 1;
  return { identifier: prefix.identifier, nextIndex };
}

const maskInlineLinks = (line, linkDefinitionIdentifiers) => {
  const characters = line.split('');
  let cursor = 0;
  while (cursor < line.length) {
    const labelStart = line.indexOf('[', cursor);
    if (labelStart === -1) break;
    if (isMarkdownEscaped(line, labelStart)) {
      cursor = labelStart + 1;
      continue;
    }
    const labelEnd = closingDelimiterIndex(line, labelStart, '[', ']');
    if (labelEnd === -1) break;
    const label = line.slice(labelStart + 1, labelEnd);
    let linkEnd;
    if (line[labelEnd + 1] === '(') {
      linkEnd = parseDestinationAndTitle(line, labelEnd + 2, true)?.end;
    } else if (line[labelEnd + 1] === '[') {
      const identifierEnd = closingDelimiterIndex(line, labelEnd + 1, '[', ']');
      if (identifierEnd !== -1) {
        const identifier = line.slice(labelEnd + 2, identifierEnd) || label;
        if (linkDefinitionIdentifiers.has(normalizedLinkIdentifier(identifier))) {
          linkEnd = identifierEnd + 1;
        }
      }
    } else if (linkDefinitionIdentifiers.has(normalizedLinkIdentifier(label))) {
      linkEnd = labelEnd + 1;
    }

    if (linkEnd !== undefined) {
      const imageStart = labelStart - 1;
      const linkStart =
        imageStart >= 0 && line[imageStart] === '!' && !isMarkdownEscaped(line, imageStart)
          ? imageStart
          : labelStart;
      maskRange(characters, linkStart, linkEnd);
      cursor = linkEnd;
      continue;
    }
    cursor = labelEnd + 1;
  }
  return characters.join('');
};

const maskInlineLinksByBlock = (lines, linkDefinitionIdentifiers) => {
  const maskedLines = [...lines];
  let blockIndexes = [];

  const maskBlock = () => {
    if (blockIndexes.length === 0) return;
    const maskedBlock = maskInlineLinks(
      blockIndexes.map(index => lines[index]).join('\n'),
      linkDefinitionIdentifiers
    ).split('\n');
    for (const [offset, index] of blockIndexes.entries()) maskedLines[index] = maskedBlock[offset];
    blockIndexes = [];
  };

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      maskBlock();
      continue;
    }
    const standaloneBlock = HEADING_PATTERN.test(line) || isThematicBreak(line);
    if (standaloneBlock || isParagraphInterruptingListItem(line)) maskBlock();
    blockIndexes.push(index);
    if (standaloneBlock) maskBlock();
  }
  maskBlock();
  return maskedLines;
};

const collectLineSyntaxIssues = ({
  index,
  line,
  lineWithoutLinks,
  setextHeadingLines,
  structuralLines,
}) => {
  const lineNumber = index + 1;
  const lineIssues = [];

  if (LITERAL_NEWLINE_PATTERN.test(maskWindowsPathTokens(line))) {
    lineIssues.push(
      issue(
        'literal-newline',
        lineNumber,
        String.raw`Replace the literal \n or \r\n separator with a real line break.`
      )
    );
  }
  if (INLINE_HEADING_PATTERN.test(lineWithoutLinks)) {
    lineIssues.push(
      issue('inline-heading', lineNumber, 'Start each Markdown heading on its own line.')
    );
  }
  if (INLINE_TASK_ITEM_PATTERN.test(lineWithoutLinks)) {
    lineIssues.push(
      issue('inline-list', lineNumber, 'Start each Markdown task-list item on its own line.')
    );
  }

  const heading = HEADING_PATTERN.test(line) || setextHeadingLines.has(index);
  const nextLineHasContent =
    index < structuralLines.length - 1 && structuralLines[index + 1]?.trim();
  if (heading && nextLineHasContent) {
    lineIssues.push(
      issue('heading-spacing', lineNumber, 'Add a blank line after the Markdown heading.')
    );
  }
  return lineIssues;
};

const collectLinkDefinitions = (sourceLines, structuralLines) => {
  const identifiers = new Set();
  const lineIndexes = new Set();
  let index = 0;
  while (index < sourceLines.length) {
    const start = index;
    if (!structuralLines[index]?.trim()) {
      index += 1;
      continue;
    }
    const definition = parseLinkDefinitionAt(sourceLines, index);
    if (!definition) {
      index += 1;
      continue;
    }
    index = definition.nextIndex;
    for (let lineIndex = start; lineIndex < index; lineIndex += 1) {
      lineIndexes.add(lineIndex);
    }
    identifiers.add(normalizedLinkIdentifier(definition.identifier));
  }
  return { identifiers, lineIndexes };
};

const collectListSpacingIssues = ({ index, line, setextHeadingLines, state, structuralLines }) => {
  const lineNumber = index + 1;
  const lineIsBlank = !line.trim();
  const listItem = !setextHeadingLines.has(index) && isTopLevelListItem(line);
  const indentedContinuation = state.inListBlock && /^(?: {2,}|\t)\S/u.test(line);
  const listIssues = [];

  if (lineIsBlank) state.inListBlock = false;
  if (listItem && !state.inListBlock && index > 0 && structuralLines[index - 1]?.trim()) {
    listIssues.push(
      issue('list-spacing-before', lineNumber, 'Add a blank line before the Markdown list.')
    );
  }
  if (state.inListBlock && !listItem && !lineIsBlank && !indentedContinuation) {
    listIssues.push(
      issue(
        'list-spacing-after',
        state.lastListItemLine,
        'Add a blank line after the Markdown list.'
      )
    );
    state.inListBlock = false;
  }
  if (listItem) {
    state.inListBlock = true;
    state.lastListItemLine = lineNumber;
  }
  return listIssues;
};

function collectSetextHeadingLineIndexes(lines) {
  const headingLines = new Set();
  let block = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || HEADING_PATTERN.test(line)) {
      block = [];
      continue;
    }
    if (SETEXT_HEADING_PATTERN.test(line) && isParagraphBlock(block)) {
      headingLines.add(index);
      block = [];
      continue;
    }
    if (isThematicBreak(line)) {
      block = [];
      continue;
    }
    block.push(line);
  }
  return headingLines;
}

export const validateMarkdownBody = body => {
  const normalizedBody = normalizeLineEndings(body);
  const unquotedBody = stripBlockquotePrefixes(normalizedBody);
  const unquotedLines = unquotedBody.split('\n');
  const renderedContentLines = new Set();
  const structuralLines = maskNonRenderedMarkdown(unquotedBody, renderedContentLines);
  const linkDefinitions = collectLinkDefinitions(unquotedLines, structuralLines);
  const linkMaskedLines = maskInlineLinksByBlock(structuralLines, linkDefinitions.identifiers);
  const syntaxLines = linkMaskedLines.map((line, index) =>
    linkDefinitions.lineIndexes.has(index) ? ' '.repeat(line.length) : line
  );
  const setextHeadingLines = collectSetextHeadingLineIndexes(structuralLines);
  const issues = [];

  if (normalizedBody.trim().length === 0) {
    return [issue('empty-body', 1, 'The body must contain Markdown content.')];
  }

  const contentLineCount = structuralLines.filter(
    (line, index) =>
      !linkDefinitions.lineIndexes.has(index) && (line.trim() || renderedContentLines.has(index))
  ).length;
  if (contentLineCount < 2) {
    issues.push(
      issue(
        'missing-real-newline',
        1,
        'The body must contain at least two content lines separated by a real line break.'
      )
    );
  }

  const listState = { inListBlock: false, lastListItemLine: 1 };
  for (const [index, line] of structuralLines.entries()) {
    const syntaxLine = syntaxLines[index];
    issues.push(
      ...collectLineSyntaxIssues({
        index,
        line,
        lineWithoutLinks: syntaxLine,
        setextHeadingLines,
        structuralLines,
      }),
      ...collectListSpacingIssues({
        index,
        line: syntaxLine,
        setextHeadingLines,
        state: listState,
        structuralLines: syntaxLines,
      })
    );
  }

  return issues;
};

export const formatValidationIssues = (issues, bodyFile = 'body.md') => {
  const details = issues.map(
    candidate => `- ${bodyFile}:${candidate.line} [${candidate.code}] ${candidate.message}`
  );
  return ['GitHub body validation failed:', ...details].join('\n');
};

export const assertValidMarkdownBody = (body, bodyFile) => {
  const issues = validateMarkdownBody(body);
  if (issues.length > 0) throw new Error(formatValidationIssues(issues, bodyFile));
};

function isLinkDefinitionBlock(block) {
  let index = 0;
  while (index < block.length) {
    const definition = parseLinkDefinitionAt(block, index);
    if (!definition) return false;
    index = definition.nextIndex;
  }
  return true;
}

function isParagraphBlock(block) {
  if (block.length === 0) return false;
  return !(
    block.some(isTopLevelListItem) ||
    INDENTED_CODE_PATTERN.test(block[0]) ||
    isLinkDefinitionBlock(block) ||
    block.some(isTableDelimiter) ||
    block.some(isThematicBreak)
  );
}

const markdownStructure = body => {
  const lines = maskNonRenderedMarkdown(stripBlockquotePrefixes(body));
  const headingLevels = [];
  let listItemCount = 0;
  let paragraphCount = 0;
  let block = [];

  const recordBlock = () => {
    if (block.length === 0) return;
    if (isParagraphBlock(block)) paragraphCount += 1;
    block = [];
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      recordBlock();
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      recordBlock();
      headingLevels.push(heading[2].length);
      continue;
    }

    const setextHeading = SETEXT_HEADING_PATTERN.exec(line);
    if (setextHeading && isParagraphBlock(block)) {
      block = [];
      headingLevels.push(setextHeading[1].startsWith('=') ? 1 : 2);
      continue;
    }

    if (isThematicBreak(line)) {
      recordBlock();
      block.push(line);
      recordBlock();
      continue;
    }

    if (isTopLevelListItem(line)) {
      listItemCount += 1;
    }
    block.push(line);
  }
  recordBlock();

  return { headingLevels, listItemCount, paragraphCount };
};

const countMatches = (value, pattern) => [...value.matchAll(pattern)].length;

export const assertGitHubRendering = (body, renderedHtml) => {
  if (!renderedHtml.trim()) throw new Error('GitHub returned an empty rendered body.');

  const expected = markdownStructure(body);
  const expectedHeadingCounts = new Map();
  for (const level of expected.headingLevels) {
    expectedHeadingCounts.set(level, (expectedHeadingCounts.get(level) ?? 0) + 1);
  }
  for (const [level, expectedCount] of expectedHeadingCounts) {
    const actualCount = countMatches(renderedHtml, new RegExp(`<h${level}(?:[ >])`, 'giu'));
    if (actualCount < expectedCount) {
      throw new Error(
        `GitHub rendering lost Markdown headings: expected ${expectedCount} h${level}, received ${actualCount}.`
      );
    }
  }

  const renderedListItems = countMatches(renderedHtml, /<li(?:[ >])/giu);
  if (renderedListItems < expected.listItemCount) {
    throw new Error(
      `GitHub rendering lost list items: expected ${expected.listItemCount}, received ${renderedListItems}.`
    );
  }

  const renderedParagraphs = countMatches(renderedHtml, /<p(?:[ >])/giu);
  if (renderedParagraphs < expected.paragraphCount) {
    throw new Error(
      `GitHub rendering collapsed paragraphs: expected ${expected.paragraphCount}, received ${renderedParagraphs}.`
    );
  }
};

const runProcess = (command, args) =>
  new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', rejectProcess);
    child.on('close', exitCode => {
      const output = Buffer.concat(stdout).toString('utf8');
      if (exitCode === 0) {
        resolveProcess(output);
        return;
      }
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      const errorDetail = errorOutput ? `: ${errorOutput}` : '.';
      rejectProcess(new Error(`gh api failed with exit code ${exitCode}${errorDetail}`));
    });
  });

const runGh = args => runProcess('gh', args);

const endpointFor = ({ kind, number, repository }) => {
  const resource = GITHUB_BODY_RESOURCES[kind];
  return `repos/${repository}/${resource}/${number}`;
};

const fetchRemoteBody = async ({ endpoint, runGhCommand }) => {
  const remoteResponse = await runGhCommand([
    'api',
    endpoint,
    '--method',
    'GET',
    '--header',
    `Accept: ${GITHUB_FULL_MEDIA_TYPE}`,
    '--header',
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
  ]);
  const remote = JSON.parse(remoteResponse);
  if (
    (remote.body !== null && typeof remote.body !== 'string') ||
    (remote.body_html !== null && typeof remote.body_html !== 'string')
  ) {
    throw new TypeError('GitHub did not return both raw and rendered body representations.');
  }
  return { ...remote, body: remote.body ?? '', body_html: remote.body_html ?? '' };
};

const assertRemoteKind = (remote, kind, number) => {
  if (kind === 'issue' && Object.hasOwn(remote, 'pull_request')) {
    throw new TypeError(
      `GitHub issue #${number} is a pull request; use --kind pr to mutate its body.`
    );
  }
};

const verifyRemoteSnapshot = ({
  endpoint,
  exactBodyMatch = false,
  kind,
  localBody,
  number,
  remote,
}) => {
  assertRemoteKind(remote, kind, number);

  const normalizedRemoteBody = normalizeLineEndings(remote.body);
  const normalizedLocalBody = normalizeLineEndings(localBody);
  const comparableRemoteBody =
    kind === 'pr' && !exactBodyMatch
      ? normalizedRemoteBody.replace(MANAGED_PR_SUFFIX_PATTERN, '')
      : normalizedRemoteBody;
  const comparableLocalBody =
    kind === 'pr' && !exactBodyMatch
      ? normalizedLocalBody.replace(MANAGED_PR_SUFFIX_PATTERN, '')
      : normalizedLocalBody;
  if (comparableRemoteBody !== comparableLocalBody) {
    throw new Error('GitHub raw body does not match the Markdown body file.');
  }
  assertValidMarkdownBody(remote.body, `${kind} #${number} raw body`);
  assertGitHubRendering(remote.body, remote.body_html);

  return { endpoint, htmlLength: remote.body_html.length };
};

const verifyRemoteBody = async ({ endpoint, kind, localBody, number, runGhCommand }) => {
  const remote = await fetchRemoteBody({ endpoint, runGhCommand });
  return verifyRemoteSnapshot({ endpoint, kind, localBody, number, remote });
};

const bodyWithPreservedManagedSuffix = ({ kind, localBody, remoteBody }) => {
  if (kind !== 'pr') return localBody;
  const managedSuffix = MANAGED_PR_SUFFIX_PATTERN.exec(remoteBody)?.[0];
  if (!managedSuffix) return localBody;
  return `${normalizeLineEndings(localBody).replace(MANAGED_PR_SUFFIX_PATTERN, '')}${managedSuffix}`;
};

export const verifyGitHubBody = async ({
  bodyFile,
  kind,
  number,
  repository,
  runGhCommand = runGh,
}) => {
  const absoluteBodyFile = resolve(bodyFile);
  const localBody = await readFile(absoluteBodyFile, 'utf8');
  assertValidMarkdownBody(localBody, absoluteBodyFile);
  const endpoint = endpointFor({ kind, number, repository });
  return verifyRemoteBody({ endpoint, kind, localBody, number, runGhCommand });
};

export const updateGitHubBody = async ({
  bodyFile,
  kind,
  number,
  repository,
  runGhCommand = runGh,
}) => {
  const absoluteBodyFile = resolve(bodyFile);
  const localBody = await readFile(absoluteBodyFile, 'utf8');
  assertValidMarkdownBody(localBody, absoluteBodyFile);

  const endpoint = endpointFor({ kind, number, repository });
  const remoteBeforeUpdate = await fetchRemoteBody({ endpoint, runGhCommand });
  assertRemoteKind(remoteBeforeUpdate, kind, number);
  const uploadBody = bodyWithPreservedManagedSuffix({
    kind,
    localBody,
    remoteBody: remoteBeforeUpdate.body,
  });
  let temporaryDirectory;
  let uploadFile = absoluteBodyFile;

  try {
    if (uploadBody !== localBody) {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'nous-github-body-upload-'));
      uploadFile = join(temporaryDirectory, 'body.md');
      await writeFile(uploadFile, uploadBody, 'utf8');
    }
    await runGhCommand([
      'api',
      endpoint,
      '--method',
      'PATCH',
      '--header',
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      '--field',
      `body=@${uploadFile}`,
      '--silent',
    ]);
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { force: true, recursive: true });
  }

  const remoteAfterUpdate = await fetchRemoteBody({ endpoint, runGhCommand });
  return verifyRemoteSnapshot({
    endpoint,
    exactBodyMatch: true,
    kind,
    localBody: uploadBody,
    number,
    remote: remoteAfterUpdate,
  });
};

const parseFlags = args => {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new TypeError(`Expected --name value arguments, received: ${args.join(' ')}`);
    }
    flags.set(flag, value);
  }
  return flags;
};

const requiredFlag = (flags, name) => {
  const value = flags.get(name);
  if (!value) throw new TypeError(`Missing required argument: ${name}`);
  return value;
};

const validateRepository = repository => {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new TypeError('--repo must use the owner/repository form.');
  }
  return repository;
};

const validateNumber = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError('--number must be a positive integer.');
  }
  return number;
};

const validateKind = kind => {
  if (!Object.hasOwn(GITHUB_BODY_RESOURCES, kind)) {
    throw new TypeError(`--kind must be ${GITHUB_BODY_KIND_USAGE}.`);
  }
  return kind;
};

const usage = `Usage:
  bun run github:body -- validate --body-file <path>
  bun run github:body -- verify --kind <${GITHUB_BODY_KIND_USAGE}> --repo <owner/repository> --number <number> --body-file <path>
  bun run github:body -- update --kind <${GITHUB_BODY_KIND_USAGE}> --repo <owner/repository> --number <number> --body-file <path>`;

export const runCli = async (args, dependencies = {}) => {
  const [command, ...flagArguments] = args;
  const flags = parseFlags(flagArguments);
  const bodyFile = requiredFlag(flags, '--body-file');

  if (command === 'validate') {
    const body = await readFile(bodyFile, 'utf8');
    assertValidMarkdownBody(body, bodyFile);
    process.stdout.write(`Validated GitHub body: ${bodyFile}\n`);
    return;
  }

  if (command === 'update' || command === 'verify') {
    const target = {
      bodyFile,
      kind: validateKind(requiredFlag(flags, '--kind')),
      number: validateNumber(requiredFlag(flags, '--number')),
      repository: validateRepository(requiredFlag(flags, '--repo')),
      runGhCommand: dependencies.runGhCommand,
    };
    const result =
      command === 'update' ? await updateGitHubBody(target) : await verifyGitHubBody(target);
    process.stdout.write(
      `${command === 'update' ? 'Updated and verified' : 'Verified'} ${result.endpoint} (${result.htmlLength} rendered HTML bytes).\n`
    );
    return;
  }

  throw new TypeError(usage);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
