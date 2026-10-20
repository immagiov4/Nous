import type { PdfTextChunk, PdfTextIndex } from './pdfTextIndex';

export interface SourceOutlineNode {
  children: SourceOutlineNode[];
  endOffset?: number;
  id: string;
  level: number;
  page?: number;
  startOffset?: number;
  title: string;
}
const TEXT_CHUNK_CHARS = 8_000;
const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 48) || 'section';

interface TextLine {
  start: number;
  text: string;
}

const splitTextLines = (text: string): TextLine[] => {
  const lines: TextLine[] = [];
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    const lineText = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    lines.push({ start: match.index, text: lineText.replace(/\r$/u, '') });
  }
  return lines;
};

const readMarkdownHeading = (line: TextLine, previousLine?: TextLine) => {
  const atxMatch = line.text.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/u);
  if (atxMatch) {
    return { title: atxMatch[2], level: atxMatch[1].length, startOffset: line.start };
  }
  const setextMatch = line.text.match(/^ {0,3}(=+|-+)\s*$/u);
  if (!setextMatch || !previousLine?.text.trim()) return;
  return {
    title: previousLine.text.trim(),
    level: setextMatch[1][0] === '=' ? 1 : 2,
    startOffset: previousLine.start,
  };
};

export const parseMarkdownOutline = (text: string, sourceId: string): SourceOutlineNode[] => {
  const lines = splitTextLines(text);
  const flatNodes: SourceOutlineNode[] = [];
  const duplicateCounts = new Map<string, number>();
  let fenceMarker = '';

  const appendHeading = (title: string, level: number, startOffset: number) => {
    const normalizedTitle = title.replace(/[ \t]+#+[ \t]*$/u, '').trim();
    if (!normalizedTitle) {
      return;
    }
    const slug = slugify(normalizedTitle);
    const occurrence = (duplicateCounts.get(slug) || 0) + 1;
    duplicateCounts.set(slug, occurrence);
    flatNodes.push({
      children: [],
      id: `${sourceId}:outline:${slug}-${occurrence}`,
      level,
      startOffset,
      title: normalizedTitle,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.text.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fenceMarker) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        fenceMarker = '';
      }
      continue;
    }
    if (fenceMarker) {
      continue;
    }

    const heading = readMarkdownHeading(line, lines[index - 1]);
    if (heading) appendHeading(heading.title, heading.level, heading.startOffset);
  }

  flatNodes.forEach((node, index) => {
    node.endOffset =
      flatNodes.slice(index + 1).find(nextNode => nextNode.level <= node.level)?.startOffset ??
      text.length;
  });

  const roots: SourceOutlineNode[] = [];
  const stack: SourceOutlineNode[] = [];
  for (const node of flatNodes) {
    while (stack.length > 0 && (stack.at(-1) as SourceOutlineNode).level >= node.level) {
      stack.pop();
    }
    const parent = stack.at(-1);
    (parent?.children || roots).push(node);
    stack.push(node);
  }
  return roots;
};

export const flattenOutline = (
  nodes: SourceOutlineNode[],
  parentTitles: string[] = []
): Array<{ node: SourceOutlineNode; path: string[] }> =>
  nodes.flatMap(node => {
    const path = [...parentTitles, node.title];
    return [{ node, path }, ...flattenOutline(node.children, path)];
  });

export const buildTextSourceIndex = (
  text: string,
  descriptor: { hash: string; id: string; name: string; outline: SourceOutlineNode[] }
): PdfTextIndex => {
  const outlineEntries = flattenOutline(descriptor.outline).filter(
    entry => entry.node.startOffset !== undefined
  );
  const outlinedRanges = outlineEntries.map((entry, index) => ({
    end: outlineEntries[index + 1]?.node.startOffset ?? text.length,
    headingPath: entry.path,
    start: entry.node.startOffset || 0,
  }));
  const firstHeadingStart = outlinedRanges[0]?.start ?? text.length;
  const preamble =
    firstHeadingStart > 0
      ? [{ start: 0, end: firstHeadingStart, headingPath: [descriptor.name] }]
      : [];
  const ranges = [...preamble, ...outlinedRanges];
  const chunks: PdfTextChunk[] = [];

  for (const range of ranges) {
    for (let offset = range.start; offset < range.end; offset += TEXT_CHUNK_CHARS) {
      const chunkText = text.slice(offset, Math.min(range.end, offset + TEXT_CHUNK_CHARS)).trim();
      if (!chunkText) {
        continue;
      }
      chunks.push({
        id: `${descriptor.id}:chunk-${String(chunks.length + 1).padStart(3, '0')}`,
        sourceId: descriptor.id,
        sequence: chunks.length,
        text: chunkText,
        headingPath: range.headingPath,
        startOffset: offset,
        endOffset: Math.min(range.end, offset + TEXT_CHUNK_CHARS),
      });
    }
  }

  return {
    kind: 'pdf-text-index',
    parsedAt: new Date().toISOString(),
    sourceHash: descriptor.hash,
    sourceIds: [descriptor.id],
    documentTitle: descriptor.name,
    chunks,
  };
};
