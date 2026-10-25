import {
  getRenderedMathSourceRanges,
  normalizeMathMarkdownSegment,
} from '@shared/markdownMathNormalization';
import remarkMath from '@shared/remarkPandocMath';
import { Fragment, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

const remarkPlugins = [remarkMath];
const rehypePlugins = [rehypeKatex];
const components = { p: ({ children }: { children?: ReactNode }) => <>{children}</> };

function scenePlainText(text: string) {
  return text.replaceAll(
    /(\\+)\$/gu,
    (_match, slashes: string) => `${'\\'.repeat(Math.floor(slashes.length / 2))}$`
  );
}

/** Scene copy is plain text except for authored mathematical notation. */
export function SceneText({ children }: { readonly children: string }) {
  const ranges = getRenderedMathSourceRanges(children);
  if (!ranges.length) return scenePlainText(children);
  return (
    <>
      {ranges.map((range, index) => {
        const plain = children.slice(ranges[index - 1]?.end ?? 0, range.start);
        return (
          <Fragment key={range.start}>
            {scenePlainText(plain)}
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
      {scenePlainText(children.slice(ranges[ranges.length - 1].end))}
    </>
  );
}
