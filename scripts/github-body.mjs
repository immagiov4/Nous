import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_FULL_MEDIA_TYPE = 'application/vnd.github.full+json';
const GITHUB_BODY_RESOURCES = Object.freeze({ issue: 'issues', pr: 'pulls' });
const GITHUB_BODY_KIND_USAGE = Object.keys(GITHUB_BODY_RESOURCES)
  .toSorted((left, right) => left.localeCompare(right))
  .join('|');
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const LITERAL_NEWLINE_PATTERN = /\\(?:r\\n|n)/gu;
const PROTECTED_AST_TYPES = new Set(['code', 'definition', 'inlineCode']);
const MANAGED_PR_SUFFIX_START = '<!-- This is an auto-generated description by cubic. -->';
const MANAGED_PR_SUFFIX_END = '<!-- End of auto-generated description by cubic. -->';
const markdownParser = unified().use(remarkParse).use(remarkGfm).freeze();

const normalizeLineEndings = body => body.replace(/\r\n?/gu, '\n');
const issue = (code, line, message) => ({ code, line, message });
const nodeOffset = (node, boundary) => node.position?.[boundary]?.offset;

const walkAst = (node, ancestors, visitor) => {
  visitor(node, ancestors);
  for (const child of node.children ?? []) walkAst(child, [...ancestors, node], visitor);
};

const parseMarkdown = body => markdownParser.parse(normalizeLineEndings(body));

const maskRange = (characters, start, end) => {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\n') characters[index] = ' ';
  }
};

const sourceWithoutProtectedMarkdown = (body, root) => {
  const characters = body.split('');
  walkAst(root, [], node => {
    if (!PROTECTED_AST_TYPES.has(node.type)) return;
    const start = nodeOffset(node, 'start');
    const end = nodeOffset(node, 'end');
    if (start !== undefined && end !== undefined) maskRange(characters, start, end);
  });
  return characters.join('');
};

const collectLiteralNewlineIssues = (body, root) => {
  const searchableBody = sourceWithoutProtectedMarkdown(body, root);
  let line = 1;
  let previousOffset = 0;
  return [...searchableBody.matchAll(LITERAL_NEWLINE_PATTERN)].map(match => {
    line += searchableBody.slice(previousOffset, match.index).split('\n').length - 1;
    previousOffset = match.index;
    return issue(
      'literal-newline',
      line,
      String.raw`Replace the literal \n or \r\n separator with a real line break.`
    );
  });
};

const collectRootBlockSpacingIssues = (root, lines) => {
  const issues = [];
  for (const node of root.children ?? []) {
    const startLine = node.position?.start.line;
    const endLine = node.position?.end.line;
    if (startLine === undefined || endLine === undefined) continue;

    if (node.type === 'heading' && lines[endLine]?.trim()) {
      issues.push(
        issue('heading-spacing', endLine, 'Add a blank line after the Markdown heading.')
      );
    }
    if (node.type !== 'list') continue;
    if (startLine > 1 && lines[startLine - 2]?.trim()) {
      issues.push(
        issue('list-spacing-before', startLine, 'Add a blank line before the Markdown list.')
      );
    }
    if (lines[endLine]?.trim()) {
      issues.push(
        issue('list-spacing-after', endLine, 'Add a blank line after the Markdown list.')
      );
    }
  }
  return issues;
};

export const validateMarkdownBody = body => {
  const normalizedBody = normalizeLineEndings(body);
  if (!normalizedBody.trim()) {
    return [issue('empty-body', 1, 'The Markdown body must not be empty.')];
  }

  const root = parseMarkdown(normalizedBody);
  const missingNewlineIssues = normalizedBody.trim().includes('\n')
    ? []
    : [issue('missing-newline', 1, 'Use real line breaks to structure the Markdown body.')];
  return [
    ...missingNewlineIssues,
    ...collectLiteralNewlineIssues(normalizedBody, root),
    ...collectRootBlockSpacingIssues(root, normalizedBody.split('\n')),
  ];
};

export const formatValidationIssues = (issues, bodyFile = 'body.md') =>
  issues.map(({ line, message }) => `${bodyFile}:${line}: ${message}`).join('\n');

export const assertValidMarkdownBody = (body, bodyFile) => {
  const issues = validateMarkdownBody(body);
  if (issues.length > 0) throw new Error(formatValidationIssues(issues, bodyFile));
};

const expectedRenderedTags = body => {
  const root = parseMarkdown(body);
  const counts = new Map();
  const increment = tag => counts.set(tag, (counts.get(tag) ?? 0) + 1);
  for (const node of root.children ?? []) {
    if (node.type === 'paragraph') increment('p');
  }
  walkAst(root, [], node => {
    if (node.type === 'heading') increment(`h${node.depth}`);
    if (node.type === 'listItem') increment('li');
  });
  return counts;
};

const renderedTagCount = (renderedHtml, tag) =>
  [...renderedHtml.matchAll(new RegExp(`<${tag}(?:[ >])`, 'giu'))].length;

export const assertGitHubRendering = (body, renderedHtml) => {
  if (!renderedHtml.trim()) throw new Error('GitHub returned an empty rendered body.');
  for (const [tag, expectedCount] of expectedRenderedTags(body)) {
    const actualCount = renderedTagCount(renderedHtml, tag);
    if (actualCount < expectedCount) {
      throw new Error(
        `GitHub rendering lost Markdown blocks: expected ${expectedCount} <${tag}>, received ${actualCount}.`
      );
    }
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
      if (exitCode === 0) {
        resolveProcess(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      const detailSuffix = detail ? `: ${detail}` : '.';
      rejectProcess(new Error(`gh api failed with exit code ${exitCode}${detailSuffix}`));
    });
  });

const runGh = args => runProcess('gh', args);

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

const endpointFor = ({ kind, number, repository }) => {
  const validKind = validateKind(kind);
  return `repos/${validateRepository(repository)}/${GITHUB_BODY_RESOURCES[validKind]}/${validateNumber(number)}`;
};

const fetchRemoteBody = async ({ endpoint, runGhCommand }) => {
  const response = await runGhCommand([
    'api',
    endpoint,
    '--method',
    'GET',
    '--header',
    `Accept: ${GITHUB_FULL_MEDIA_TYPE}`,
    '--header',
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
  ]);
  const remote = JSON.parse(response);
  if (
    !remote ||
    typeof remote !== 'object' ||
    (remote.body !== null && typeof remote.body !== 'string') ||
    (remote.body_html !== null && typeof remote.body_html !== 'string')
  ) {
    throw new TypeError('GitHub did not return both raw and rendered body representations.');
  }
  return { ...remote, body: remote.body ?? '', body_html: remote.body_html ?? '' };
};

const assertRemoteKind = (remote, kind, number) => {
  if (kind === 'issue' && Object.hasOwn(remote, 'pull_request')) {
    throw new TypeError(`GitHub issue #${number} is a pull request; use --kind pr.`);
  }
};

const managedPrSuffix = body => {
  const normalizedBody = normalizeLineEndings(body);
  const root = parseMarkdown(normalizedBody);
  const children = root.children ?? [];
  const occurrenceCount = (value, marker) => value.split(marker).length - 1;
  let activeStartCount = 0;
  let activeEndCount = 0;
  walkAst(root, [], node => {
    if (node.type !== 'html') return;
    activeStartCount += occurrenceCount(node.value, MANAGED_PR_SUFFIX_START);
    activeEndCount += occurrenceCount(node.value, MANAGED_PR_SUFFIX_END);
  });
  if (activeStartCount === 0 && activeEndCount === 0) return undefined;

  const markerIndexes = marker =>
    children.flatMap((node, index) =>
      node.type === 'html' && node.value.trim() === marker ? [index] : []
    );
  const startIndexes = markerIndexes(MANAGED_PR_SUFFIX_START);
  const endIndexes = markerIndexes(MANAGED_PR_SUFFIX_END);
  if (
    activeStartCount !== 1 ||
    activeEndCount !== 1 ||
    startIndexes.length !== 1 ||
    endIndexes.length !== 1 ||
    startIndexes[0] >= endIndexes[0]
  ) {
    throw new Error('The managed pull request body markers are incomplete or ambiguous.');
  }
  const suffixStart = nodeOffset(children[startIndexes[0]], 'start');
  if (suffixStart === undefined) {
    throw new Error('The managed pull request body start marker has no source position.');
  }
  return normalizedBody.slice(suffixStart);
};

const bodyWithoutManagedPrSuffix = body => {
  const normalizedBody = normalizeLineEndings(body);
  const suffix = managedPrSuffix(normalizedBody);
  return suffix ? normalizedBody.slice(0, -suffix.length).trimEnd() : normalizedBody;
};

const bodyWithPreservedManagedSuffix = ({ kind, localBody, remoteBody }) => {
  if (kind !== 'pr') return localBody;
  const localBodyWithoutManagedSuffix = bodyWithoutManagedPrSuffix(localBody).trimEnd();
  const suffix = managedPrSuffix(remoteBody);
  return suffix ? `${localBodyWithoutManagedSuffix}\n\n${suffix}` : localBodyWithoutManagedSuffix;
};

const comparableBody = (body, kind, exactBodyMatch) => {
  const normalizedBody = normalizeLineEndings(body);
  return kind === 'pr' && !exactBodyMatch
    ? bodyWithoutManagedPrSuffix(normalizedBody).trimEnd()
    : normalizedBody;
};

const verifyRemoteSnapshot = ({ exactBodyMatch = false, kind, localBody, number, remote }) => {
  assertRemoteKind(remote, kind, number);
  if (
    comparableBody(remote.body, kind, exactBodyMatch) !==
    comparableBody(localBody, kind, exactBodyMatch)
  ) {
    throw new Error('GitHub raw body does not match the Markdown body file.');
  }
  assertValidMarkdownBody(remote.body, `${kind} #${number} raw body`);
  assertGitHubRendering(remote.body, remote.body_html);
  return { htmlLength: Buffer.byteLength(remote.body_html, 'utf8') };
};

const renderGitHubMarkdown = ({ bodyFile, repository, runGhCommand }) =>
  runGhCommand([
    'api',
    'markdown',
    '--method',
    'POST',
    '--header',
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    '--field',
    `text=@${bodyFile}`,
    '--field',
    'mode=gfm',
    '--field',
    `context=${repository}`,
  ]);

const withBodySnapshot = async (prefix, body, operation) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const bodyFile = join(directory, 'body.md');
  try {
    await writeFile(bodyFile, body, 'utf8');
    return await operation(bodyFile);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

export const previewGitHubBody = async ({ bodyFile, repository, runGhCommand = runGh }) => {
  const body = await readFile(resolve(bodyFile), 'utf8');
  assertValidMarkdownBody(body, resolve(bodyFile));
  const validRepository = validateRepository(repository);
  return withBodySnapshot('nous-github-body-preview-', body, async snapshotFile => {
    const rendered = await renderGitHubMarkdown({
      bodyFile: snapshotFile,
      repository: validRepository,
      runGhCommand,
    });
    assertGitHubRendering(body, rendered);
    return { htmlLength: Buffer.byteLength(rendered, 'utf8') };
  });
};

export const verifyGitHubBody = async ({
  bodyFile,
  kind,
  number,
  repository,
  runGhCommand = runGh,
}) => {
  const localBody = await readFile(resolve(bodyFile), 'utf8');
  assertValidMarkdownBody(localBody, resolve(bodyFile));
  const endpoint = endpointFor({ kind, number, repository });
  const remote = await fetchRemoteBody({ endpoint, runGhCommand });
  return { endpoint, ...verifyRemoteSnapshot({ kind, localBody, number, remote }) };
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
  assertValidMarkdownBody(
    kind === 'pr' ? bodyWithoutManagedPrSuffix(localBody) : localBody,
    absoluteBodyFile
  );
  const endpoint = endpointFor({ kind, number, repository });
  const remoteBefore = await fetchRemoteBody({ endpoint, runGhCommand });
  assertRemoteKind(remoteBefore, kind, number);
  const uploadBody = bodyWithPreservedManagedSuffix({
    kind,
    localBody,
    remoteBody: remoteBefore.body,
  });
  assertValidMarkdownBody(uploadBody, `${absoluteBodyFile} with remote managed suffix`);

  await withBodySnapshot('nous-github-body-upload-', uploadBody, async snapshotFile => {
    const rendered = await renderGitHubMarkdown({
      bodyFile: snapshotFile,
      repository,
      runGhCommand,
    });
    assertGitHubRendering(uploadBody, rendered);
    const remoteBeforePatch = await fetchRemoteBody({ endpoint, runGhCommand });
    assertRemoteKind(remoteBeforePatch, kind, number);
    if (normalizeLineEndings(remoteBeforePatch.body) !== normalizeLineEndings(remoteBefore.body)) {
      throw new Error('GitHub body changed during update; no changes were applied.');
    }
    await runGhCommand([
      'api',
      endpoint,
      '--method',
      'PATCH',
      '--header',
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      '--field',
      `body=@${snapshotFile}`,
      '--silent',
    ]);
  });

  const remoteAfter = await fetchRemoteBody({ endpoint, runGhCommand });
  return {
    endpoint,
    ...verifyRemoteSnapshot({
      exactBodyMatch: true,
      kind,
      localBody: uploadBody,
      number,
      remote: remoteAfter,
    }),
  };
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

const usage = `Usage:
  bun run github:body -- validate --body-file <path>
  bun run github:body -- preview --repo <owner/repository> --body-file <path>
  bun run github:body -- verify --kind <${GITHUB_BODY_KIND_USAGE}> --repo <owner/repository> --number <number> --body-file <path>
  bun run github:body -- update --kind <${GITHUB_BODY_KIND_USAGE}> --repo <owner/repository> --number <number> --body-file <path>`;

export const runCli = async (args, dependencies = {}) => {
  const [command, ...flagArguments] = args;
  const flags = parseFlags(flagArguments);
  const bodyFile = requiredFlag(flags, '--body-file');
  if (command === 'validate') {
    assertValidMarkdownBody(await readFile(bodyFile, 'utf8'), bodyFile);
    process.stdout.write(`Validated GitHub body: ${bodyFile}\n`);
    return;
  }
  if (command === 'preview') {
    const result = await previewGitHubBody({
      bodyFile,
      repository: requiredFlag(flags, '--repo'),
      runGhCommand: dependencies.runGhCommand,
    });
    process.stdout.write(`Previewed GitHub body (${result.htmlLength} rendered HTML bytes).\n`);
    return;
  }
  if (command === 'update' || command === 'verify') {
    const operation = command === 'update' ? updateGitHubBody : verifyGitHubBody;
    const result = await operation({
      bodyFile,
      kind: requiredFlag(flags, '--kind'),
      number: requiredFlag(flags, '--number'),
      repository: requiredFlag(flags, '--repo'),
      runGhCommand: dependencies.runGhCommand,
    });
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
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
