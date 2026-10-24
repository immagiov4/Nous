import {
  getRenderedMathSourceRanges,
  normalizeMathMarkdownSegment,
} from '@shared/markdownMathNormalization';
import { Fragment, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

const remarkPlugins = [remarkMath];
const rehypePlugins = [rehypeKatex];
const components = { p: ({ children }: { children?: ReactNode }) => <>{children}</> };

/** Scene copy is plain text except for authored mathematical notation. */
export function SceneText({ children }: { readonly children: string }) {
  const ranges = getRenderedMathSourceRanges(children);
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
