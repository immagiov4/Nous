import {
  getRenderedMathSourceRanges,
  normalizeMathMarkdownSegment,
} from '@shared/markdownMathNormalization';
import { Fragment, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { getMarkdownMathRangeAt } from '@shared/markdownMathSyntax';

const remarkPlugins = [remarkMath];
const rehypePlugins = [rehypeKatex];
const components = { p: ({ children }: { children?: ReactNode }) => <>{children}</> };

function canCloseDollarMath(source: string, end: number) {
  const before = source[end - 2];
  const after = source[end] ?? ' ';
  // An opening bracket belongs to the following expression; closing braces may precede prose.
  return !(
    /\s/u.test(before) ||
    /\d/u.test(after) ||
    (/\p{Ps}/u.test(before) && /\S/u.test(after))
  );
}

/** Scene copy is plain text except for authored mathematical notation. */
export function SceneText({ children }: { readonly children: string }) {
  // Preserve literal prices while retaining authored dollar-delimited mathematics.
  const mathSource = children.split('');
  for (let cursor = 0; cursor < children.length; cursor++) {
    const range = getMarkdownMathRangeAt(children, cursor);
    if (!range) continue;
    if (
      children[cursor] === '$' &&
      children[cursor + 1] !== '$' &&
      (/\s/u.test(children[cursor + 1]) || !canCloseDollarMath(children, range.end))
    ) {
      mathSource[cursor] = '\0';
    } else cursor = range.end - 1;
  }
  const ranges = getRenderedMathSourceRanges(mathSource.join(''));
  if (!ranges.length) return children;
  return (
    <>
      {ranges.map((range, index) => {
        const plain = children.slice(ranges[index - 1]?.end ?? 0, range.start);
        return (
          <Fragment key={range.start}>
            {plain}
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={components}
            >
              {normalizeMathMarkdownSegment(children.slice(range.start, range.end))}
            </ReactMarkdown>
          </Fragment>
        );
      })}
      {children.slice(ranges[ranges.length - 1].end)}
    </>
  );
}
