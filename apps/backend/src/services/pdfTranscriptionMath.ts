import { normalizeMathMarkdownSegment } from '@shared/markdownMathNormalization';
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

/** Uses the reader's math normalization and KaTeX version before source text is accepted. */
export const getPdfTranscriptionMathErrors = (markdown: string): string[] => {
  const normalized = normalizeMathMarkdownSegment(markdown);
  const tree = parser.parse(normalized) as MarkdownNode;
  const errors: string[] = [];
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
