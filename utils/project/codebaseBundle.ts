import JSZip from 'jszip';
import type { CodebaseBundleSource, CodebaseSourceFile } from '../../types';

const DEFAULT_MAX_TOTAL_CHARS = 220_000;
const DEFAULT_MAX_FILE_CHARS = 24_000;

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.idea',
  '.vscode',
  '__pycache__',
  'bin',
  'obj',
  '.vs',
  'vendor',
  'packages',
]);

export interface CodebaseBundleBuildEntry {
  path: string;
  text: string;
}

export interface CodebaseBundleBuildOptions {
  maxFileChars?: number;
  maxTotalChars?: number;
}

export const isBinaryFile = (uint8Array: Uint8Array): boolean => {
  const checkLength = Math.min(uint8Array.length, 1024);

  for (let index = 0; index < checkLength; index += 1) {
    if (uint8Array[index] === 0) {
      return true;
    }
  }

  return false;
};

const shouldIgnorePath = (relativePath: string): boolean =>
  relativePath.split('/').some(part => IGNORED_DIRS.has(part) || part.startsWith('.'));

const normalizeSourceText = (text: string): string => text.replace(/\r\n?/g, '\n').trim();

const clipText = (text: string, maxChars: number): { text: string; truncated: boolean } => {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n[TRUNCATED FOR CONTEXT BUDGET]`,
    truncated: true,
  };
};

export const buildCodebaseBundleSource = (
  name: string,
  entries: CodebaseBundleBuildEntry[],
  options: CodebaseBundleBuildOptions = {}
): CodebaseBundleSource => {
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const maxFileChars = options.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;
  const sortedEntries = entries
    .map(entry => ({ ...entry, path: entry.path.replace(/\\/g, '/') }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const files: CodebaseSourceFile[] = [];
  let skippedFileCount = 0;
  let truncatedFileCount = 0;
  let totalCharacterCount = 0;

  for (const entry of sortedEntries) {
    const normalizedText = normalizeSourceText(entry.text);
    if (!normalizedText) {
      skippedFileCount += 1;
      continue;
    }

    if (totalCharacterCount >= maxTotalChars) {
      skippedFileCount += 1;
      continue;
    }

    const remainingChars = Math.max(0, maxTotalChars - totalCharacterCount);
    const clipBudget = Math.min(maxFileChars, remainingChars);
    if (clipBudget <= 0) {
      skippedFileCount += 1;
      continue;
    }

    const clipped = clipText(normalizedText, clipBudget);
    files.push({
      path: entry.path.replace(/\\/g, '/'),
      text: clipped.text,
      truncated: clipped.truncated || undefined,
    });

    totalCharacterCount += clipped.text.length;
    if (clipped.truncated) {
      truncatedFileCount += 1;
    }
  }

  if (files.length === 0) {
    throw new Error('No readable text files found in this archive.');
  }

  const aggregatedText = [
    'This bundle contains the source code of a project. Analyze it as a whole codebase.',
    ...files.map(file => `--- START OF FILE: ${file.path} ---\n${file.text}`),
  ].join('\n\n');

  return {
    kind: 'codebase-bundle',
    name,
    aggregatedText,
    files,
    stats: {
      includedFileCount: files.length,
      skippedFileCount,
      truncatedFileCount,
      totalCharacterCount: aggregatedText.length,
    },
  };
};

export const createCodebaseBundleSourceFromZip = async (
  file: File,
  options: CodebaseBundleBuildOptions = {}
): Promise<CodebaseBundleSource> => {
  const zip = new JSZip();
  const contents = await zip.loadAsync(file);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = Object.values(contents.files)
    .filter(entry => !entry.dir)
    .filter(entry => !shouldIgnorePath(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  const readableEntries: CodebaseBundleBuildEntry[] = [];
  let skippedBinaryCount = 0;

  for (const entry of entries) {
    const rawData = await entry.async('uint8array');
    if (isBinaryFile(rawData)) {
      skippedBinaryCount += 1;
      continue;
    }

    try {
      const text = decoder.decode(rawData);
      readableEntries.push({
        path: entry.name,
        text,
      });
    } catch {
      // intentional: fallback to default
      skippedBinaryCount += 1;
    }
  }

  const bundle = buildCodebaseBundleSource(file.name, readableEntries, options);
  return {
    ...bundle,
    stats: {
      ...bundle.stats,
      skippedFileCount: bundle.stats.skippedFileCount + skippedBinaryCount,
    },
  };
};
