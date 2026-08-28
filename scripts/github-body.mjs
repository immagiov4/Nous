import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_FULL_MEDIA_TYPE = 'application/vnd.github.full+json';
const GITHUB_BODY_RESOURCES = Object.freeze({ issue: 'issues', pr: 'pulls' });
const GITHUB_BODY_KIND_USAGE = Object.keys(GITHUB_BODY_RESOURCES).toSorted().join('|');
const HEADING_PATTERN = /^( {0,3})(#{1,6})(?:[ \t]+|$)/u;
const LIST_ITEM_PATTERN = /^( {0,3})(?:[-+*]|\d{1,3}[.)])[ \t]+\S/u;
const INLINE_HEADING_PATTERN = /\S[ \t]+#{1,6}(?:[ \t]+\S|[ \t]*$)/u;
const INLINE_TASK_ITEM_PATTERN = /\S[ \t]+(?:[-+*]|\d{1,3}[.)])[ \t]+\[(?: |x|X)\][ \t]+\S/u;
const LITERAL_NEWLINE_PATTERN = /\\(?:r\\n|n)/u;
const MANAGED_CUBIC_DESCRIPTION_PATTERN =
  /\n\n<!-- This is an auto-generated description by cubic\. -->[\s\S]*?<!-- End of auto-generated description by cubic\. -->[ \t]*\n*$/u;
const BLOCKQUOTE_PREFIX_PATTERN = /^(?: {0,3}>[ \t]?)+/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SETEXT_HEADING_PATTERN = /^ {0,3}(=+|-+)[ \t]*$/u;
const TABLE_DELIMITER_PATTERN = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/u;
const THEMATIC_BREAK_PATTERN = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;

const normalizeLineEndings = body => body.replace(/\r\n?/gu, '\n');
const isTopLevelListItem = line =>
  LIST_ITEM_PATTERN.test(line) && !THEMATIC_BREAK_PATTERN.test(line);
const stripBlockquotePrefix = line => line.replace(BLOCKQUOTE_PREFIX_PATTERN, '');
const stripBlockquotePrefixes = body =>
  normalizeLineEndings(body).split('\n').map(stripBlockquotePrefix).join('\n');

const maskRange = (characters, start, end) => {
  for (let index = start; index < end; index += 1) characters[index] = ' ';
};

const maskInlineCodeAndHtmlComments = (line, state) => {
  const characters = line.split('');
  let cursor = 0;

  while (cursor < line.length) {
    if (state.inHtmlComment) {
      const commentEnd = line.indexOf('-->', cursor);
      if (commentEnd === -1) {
        maskRange(characters, cursor, line.length);
        break;
      }
      maskRange(characters, cursor, commentEnd + 3);
      state.inHtmlComment = false;
      cursor = commentEnd + 3;
      continue;
    }

    const commentStart = line.indexOf('<!--', cursor);
    const inlineCode = /(`+)([^`]*?)\1/u.exec(line.slice(cursor));
    const inlineCodeStart = inlineCode ? cursor + inlineCode.index : -1;
    if (inlineCodeStart !== -1 && (commentStart === -1 || inlineCodeStart < commentStart)) {
      maskRange(characters, inlineCodeStart, inlineCodeStart + inlineCode[0].length);
      cursor = inlineCodeStart + inlineCode[0].length;
      continue;
    }
    if (commentStart === -1) break;
    const commentEnd = line.indexOf('-->', commentStart + 4);
    if (commentEnd === -1) {
      maskRange(characters, commentStart, line.length);
      state.inHtmlComment = true;
      break;
    }
    maskRange(characters, commentStart, commentEnd + 3);
    cursor = commentEnd + 3;
  }

  return characters.join('');
};

const maskNonRenderedMarkdown = body => {
  const state = { fence: undefined, inHtmlComment: false };

  return normalizeLineEndings(body)
    .split('\n')
    .map(line => {
      if (state.inHtmlComment) return maskInlineCodeAndHtmlComments(line, state);

      if (state.fence) {
        const closingFence = new RegExp(
          `^ {0,3}${state.fence.character}{${state.fence.length},}[ \\t]*$`,
          'u'
        );
        if (closingFence.test(line)) state.fence = undefined;
        return ' '.repeat(line.length);
      }

      const openingFence = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (openingFence) {
        const marker = openingFence[1];
        state.fence = { character: marker[0], length: marker.length };
        return ' '.repeat(line.length);
      }

      return maskInlineCodeAndHtmlComments(line, state);
    });
};

const issue = (code, line, message) => ({ code, line, message });

export const validateMarkdownBody = body => {
  const normalizedBody = normalizeLineEndings(body);
  const lines = normalizedBody.split('\n');
  const structuralLines = maskNonRenderedMarkdown(stripBlockquotePrefixes(normalizedBody));
  const issues = [];

  if (normalizedBody.trim().length === 0) {
    return [issue('empty-body', 1, 'The body must contain Markdown content.')];
  }

  const contentLineCount = structuralLines.filter(line => line.trim()).length;
  if (contentLineCount < 2) {
    issues.push(
      issue(
        'missing-real-newline',
        1,
        'The body must contain at least two content lines separated by a real line break.'
      )
    );
  }

  let inListBlock = false;
  let lastListItemLine = 1;
  for (const [index, line] of structuralLines.entries()) {
    const lineNumber = index + 1;
    const lineIsBlank = !line.trim();
    const listItem = isTopLevelListItem(line);
    const indentedListContinuation = inListBlock && /^(?: {2,}|\t)\S/u.test(line);

    if (lineIsBlank) inListBlock = false;

    if (LITERAL_NEWLINE_PATTERN.test(line)) {
      issues.push(
        issue(
          'literal-newline',
          lineNumber,
          'Replace the literal \\n or \\r\\n separator with a real line break.'
        )
      );
    }

    if (INLINE_HEADING_PATTERN.test(line)) {
      issues.push(
        issue('inline-heading', lineNumber, 'Start each Markdown heading on its own line.')
      );
    }

    if (INLINE_TASK_ITEM_PATTERN.test(line)) {
      issues.push(
        issue('inline-list', lineNumber, 'Start each Markdown task-list item on its own line.')
      );
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading && index < lines.length - 1 && structuralLines[index + 1]?.trim() !== '') {
      issues.push(
        issue('heading-spacing', lineNumber, 'Add a blank line after the Markdown heading.')
      );
    }

    if (listItem && !inListBlock && index > 0 && structuralLines[index - 1]?.trim()) {
      issues.push(
        issue('list-spacing-before', lineNumber, 'Add a blank line before the Markdown list.')
      );
    }

    if (inListBlock && !listItem && !lineIsBlank && !indentedListContinuation) {
      issues.push(
        issue('list-spacing-after', lastListItemLine, 'Add a blank line after the Markdown list.')
      );
      inListBlock = false;
    }

    if (listItem) {
      inListBlock = true;
      lastListItemLine = lineNumber;
    }
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

const markdownStructure = body => {
  const lines = maskNonRenderedMarkdown(stripBlockquotePrefixes(body));
  const headingLevels = [];
  let listItemCount = 0;
  let paragraphCount = 0;
  let block = [];

  const recordBlock = () => {
    if (block.length === 0) return;

    const setextMarker = block.length > 1 ? SETEXT_HEADING_PATTERN.exec(block.at(-1)) : undefined;
    if (setextMarker) {
      headingLevels.push(setextMarker[1].startsWith('=') ? 1 : 2);
      block = [];
      return;
    }

    const containsList = block.some(isTopLevelListItem);
    const isRawHtml = /^ {0,3}<\/?[A-Za-z][^>]*>/u.test(block[0]);
    const isIndentedCode = /^(?: {4,}|\t)\S/u.test(block[0]);
    const isLinkDefinition = block.every(line => /^ {0,3}\[[^\]]+\]:[ \t]+\S/u.test(line));
    const isTable = block.some(line => TABLE_DELIMITER_PATTERN.test(line));
    const isThematicBreak = block.length === 1 && THEMATIC_BREAK_PATTERN.test(block[0]);
    if (
      !containsList &&
      !isRawHtml &&
      !isIndentedCode &&
      !isLinkDefinition &&
      !isTable &&
      !isThematicBreak
    ) {
      paragraphCount += 1;
    }
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
  for (const level of expected.headingLevels) {
    const expectedCount = expected.headingLevels.filter(candidate => candidate === level).length;
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
      rejectProcess(
        new Error(
          `gh api failed with exit code ${exitCode}${errorOutput ? `: ${errorOutput}` : '.'}`
        )
      );
    });
  });

const runGh = args => runProcess('gh', args);

const endpointFor = ({ kind, number, repository }) => {
  const resource = GITHUB_BODY_RESOURCES[kind];
  return `repos/${repository}/${resource}/${number}`;
};

const verifyRemoteBody = async ({ endpoint, kind, localBody, number, runGhCommand }) => {
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
  if (typeof remote.body !== 'string' || typeof remote.body_html !== 'string') {
    throw new TypeError('GitHub did not return both raw and rendered body representations.');
  }

  const normalizedRemoteBody = normalizeLineEndings(remote.body);
  const comparableRemoteBody =
    kind === 'pr'
      ? normalizedRemoteBody.replace(MANAGED_CUBIC_DESCRIPTION_PATTERN, '')
      : normalizedRemoteBody;
  if (comparableRemoteBody !== normalizeLineEndings(localBody)) {
    throw new Error('GitHub raw body does not match the Markdown body file.');
  }
  assertValidMarkdownBody(remote.body, `${kind} #${number} raw body`);
  assertGitHubRendering(remote.body, remote.body_html);

  return { endpoint, htmlLength: remote.body_html.length };
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
  await runGhCommand([
    'api',
    endpoint,
    '--method',
    'PATCH',
    '--header',
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    '--field',
    `body=@${absoluteBodyFile}`,
    '--silent',
  ]);

  return verifyRemoteBody({ endpoint, kind, localBody, number, runGhCommand });
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
