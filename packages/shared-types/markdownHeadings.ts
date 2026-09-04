import remarkParse from 'remark-parse';
import { unified } from 'unified';

const markdownParser = unified().use(remarkParse);
const ATX_HEADING_PREFIX = /^(#{1,6})\s+/u;

export interface MarkdownHeadingLocation {
  heading: string;
  lineIndex: number;
}

interface MarkdownRoot {
  children: Array<{
    position?: { start: { line?: number } };
    type: string;
  }>;
}

export const getMarkdownHeadingLocations = (contentMarkdown: string): MarkdownHeadingLocation[] => {
  const lines = contentMarkdown.split(/\r\n?|\n/u);
  const tree = markdownParser.parse(contentMarkdown) as MarkdownRoot;

  return tree.children.flatMap(node => {
    if (node.type !== 'heading' || !node.position?.start.line) return [];
    const lineIndex = node.position.start.line - 1;
    const sourceLine = lines[lineIndex]?.trim() ?? '';
    if (!ATX_HEADING_PREFIX.test(sourceLine)) return [];
    const heading = sourceLine.replace(ATX_HEADING_PREFIX, '').trim();
    return heading ? [{ heading, lineIndex }] : [];
  });
};

export const getMarkdownHeadings = (contentMarkdown: string): string[] =>
  getMarkdownHeadingLocations(contentMarkdown).map(location => location.heading);
