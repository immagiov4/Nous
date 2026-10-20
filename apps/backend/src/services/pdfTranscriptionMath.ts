import { normalizeMathMarkdownSegment } from '@shared/markdownMathNormalization';
import { getMarkdownMathRangeAt } from '@shared/markdownMathSyntax';
import { renderToString } from 'katex';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset: number }; end: { offset: number } };
}
const parser = unified().use(remarkParse).use(remarkMath);

const readMarkdownCodeRanges = (markdown: string) => {
  const ranges: Array<{ start: number; end: number }> = [];
  const visit = (node: MarkdownNode): void => {
    if ((node.type === 'code' || node.type === 'inlineCode') && node.position)
      ranges.push({ start: node.position.start.offset, end: node.position.end.offset });
    else node.children?.forEach(visit);
  };
  visit(parser.parse(markdown) as MarkdownNode);
  return ranges;
};

const formatMultilineMath = (
  markdown: string,
  range: { start: number; end: number },
  expression: string
): string => {
  if (!expression.startsWith('$') || !expression.includes('\n')) return expression;
  const delimiterLength = expression.startsWith('$$') ? 2 : 1;
  const prefix = range.start > 0 && markdown[range.start - 1] !== '\n' ? '\n' : '';
  const suffix = range.end < markdown.length && markdown[range.end] !== '\n' ? '\n' : '';
  return [
    prefix,
    '$$\n',
    expression.slice(delimiterLength, -delimiterLength).trim(),
    '\n$$',
    suffix,
  ].join('');
};

/** Canonicalizes Markdown math layout without changing a mathematical symbol or row separator. */
export const normalizePdfTranscriptionMarkdown = (markdown: string): string => {
  const codeRanges = readMarkdownCodeRanges(markdown);
  let normalized = '';
  let cursor = 0;
  let plainStart = 0;
  while (cursor < markdown.length) {
    const code = codeRanges.find(range => range.start <= cursor && cursor < range.end);
    if (code) {
      cursor = code.end;
      continue;
    }
    const range = getMarkdownMathRangeAt(markdown, cursor, { allowInlineNewlines: true });
    if (!range || codeRanges.some(code => range.start < code.end && range.end > code.start)) {
      cursor += 1;
      continue;
    }
    const expression = markdown.slice(range.start, range.end);
    const replacement = formatMultilineMath(markdown, range, expression);
    normalized += markdown.slice(plainStart, range.start) + replacement;
    cursor = range.end;
    plainStart = cursor;
  }
  return normalized + markdown.slice(plainStart);
};

/** Uses the reader's math normalization and KaTeX version before source text is accepted. */
export const getPdfTranscriptionMathErrors = (markdown: string): string[] => {
  const normalized = normalizeMathMarkdownSegment(markdown);
  const tree = parser.parse(normalized) as MarkdownNode;
  const errors: string[] = [];
  if (/[\p{Cc}\ufffd]/u.test(markdown.replaceAll(/[\t\n\r]/g, '')))
    errors.push('Invalid control or replacement characters. Return readable Unicode text.');
  const visit = (node: MarkdownNode): void => {
    if (
      node.type === 'text' &&
      node.position &&
      /(^|[^\\])(?:\\\\)*\$/u.test(
        normalized.slice(node.position.start.offset, node.position.end.offset)
      )
    ) {
      errors.push(
        'Unclosed math delimiter or unescaped literal dollar sign. Escape literal dollar signs in prose.'
      );
    }
    if ((node.type === 'math' || node.type === 'inlineMath') && node.value !== undefined) {
      try {
        renderToString(node.value, {
          displayMode: node.type === 'math',
          throwOnError: true,
          strict: 'ignore',
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Invalid LaTeX expression.');
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return errors;
};
