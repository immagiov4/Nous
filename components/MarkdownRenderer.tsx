import { memo, type CSSProperties, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { LessonImageRef, PdfImageAsset } from '../types';
import { parsePdfContentParts } from '../utils/pdfImagePlaceholders';
import { normalizeMarkdownForRendering } from '../utils/renderMarkdown.ts';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  isDarkMode?: boolean;
  onContextMenu?: (e: MouseEvent) => void;
  lessonAssetsById?: Record<string, PdfImageAsset>;
  lessonImageRefsById?: Record<string, LessonImageRef>;
}

interface CodeRendererProps extends HTMLAttributes<HTMLElement> {
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}

const articleClassName = (className: string) =>
  `prose w-full min-w-0 max-w-none overflow-x-hidden break-words [overflow-wrap:anywhere] [&_*]:max-w-full [&_figure]:not-prose [&_figure]:mx-0 [&_figure_img]:my-0 [&_mark]:bg-orange-200 [&_mark]:text-gray-900 [&_mark]:px-1 [&_mark]:py-0.5 [&_mark]:rounded [&_mark]:mx-0.5 [&_mark]:decoration-clone [&_mark]:box-decoration-clone dark:[&_mark]:bg-orange-900/50 dark:[&_mark]:text-white ${className}`;

const buildMarkdownComponents = (
  syntaxTheme: { [key: string]: CSSProperties },
  isDarkMode: boolean
) => ({
  code({ inline, className, children }: CodeRendererProps) {
    const match = /language-(\w+)/.exec(className || '');

    return !inline && match ? (
      <div className="my-4 overflow-hidden rounded-lg border border-gray-200 shadow-sm dark:border-zinc-800">
        <SyntaxHighlighter
          style={syntaxTheme}
          language={match[1]}
          PreTag="div"
          customStyle={{
            margin: 0,
            padding: '1.5rem',
            fontSize: '0.9rem',
            backgroundColor: isDarkMode ? '#18181b' : '#f9fafb',
          }}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      </div>
    ) : (
      <code className="inherit-color rounded bg-black/5 px-1.5 py-0.5 text-sm font-mono font-bold dark:bg-white/10">
        {children}
      </code>
    );
  },
  blockquote({ children }: { children?: ReactNode }) {
    return (
      <blockquote className="my-2 border-l-4 border-current pl-4 py-2 italic opacity-80">
        {children}
      </blockquote>
    );
  },
  a({ href, children }: { href?: string; children?: ReactNode }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-1 underline-offset-2 hover:opacity-80">
        {children}
      </a>
    );
  },
  mark({ children }: { children?: ReactNode }) {
    return (
      <mark className="mx-0.5 rounded bg-orange-200 px-1 py-0.5 text-gray-900 decoration-clone box-decoration-clone dark:bg-orange-900/50 dark:text-white">
        {children}
      </mark>
    );
  },
  table({ children }: { children?: ReactNode }) {
    return (
      <div className="my-6 overflow-x-auto rounded-2xl border border-gray-200/80 dark:border-zinc-800">
        <table className="m-0 w-full border-collapse text-left text-sm">
          {children}
        </table>
      </div>
    );
  },
  thead({ children }: { children?: ReactNode }) {
    return <thead className="bg-gray-50/90 dark:bg-zinc-900/90">{children}</thead>;
  },
  tbody({ children }: { children?: ReactNode }) {
    return <tbody className="divide-y divide-gray-200/70 dark:divide-zinc-800">{children}</tbody>;
  },
  tr({ children }: { children?: ReactNode }) {
    return <tr className="align-top">{children}</tr>;
  },
  th({ children }: { children?: ReactNode }) {
    return (
      <th className="border-b border-gray-200/80 px-4 py-3 font-semibold text-gray-900 dark:border-zinc-800 dark:text-gray-100">
        {children}
      </th>
    );
  },
  td({ children }: { children?: ReactNode }) {
    return (
      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
        {children}
      </td>
    );
  },
});

const MarkdownRenderer = ({
  content,
  className = '',
  isDarkMode = false,
  onContextMenu,
  lessonAssetsById = {},
  lessonImageRefsById = {},
}: MarkdownRendererProps) => {
  const syntaxTheme: { [key: string]: CSSProperties } = isDarkMode
    ? (oneDark as unknown as { [key: string]: CSSProperties })
    : (oneLight as unknown as { [key: string]: CSSProperties });
  const contentParts = parsePdfContentParts(content, lessonAssetsById, lessonImageRefsById);
  const markdownComponents = buildMarkdownComponents(syntaxTheme, isDarkMode);

  return (
    <article
      className={articleClassName(className)}
      onContextMenu={onContextMenu}
    >
      {contentParts.map(part =>
        part.type === 'markdown' ? (
          <ReactMarkdown
            key={part.key}
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex, rehypeRaw]}
            components={markdownComponents}
          >
            {normalizeMarkdownForRendering(part.content)}
          </ReactMarkdown>
        ) : (
          <figure
            key={part.key}
            className="my-10 overflow-hidden rounded-[28px] border border-gray-200/80 bg-white/85 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/85"
          >
            <img
              src={part.asset.dataUrl}
              alt={part.alt}
              loading="lazy"
              data-pdf-asset-id={part.asset.id}
              className="m-0 block w-full bg-gray-50 dark:bg-zinc-950"
            />
            {part.caption ? (
              <figcaption className="px-5 py-4 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                {part.caption}
              </figcaption>
            ) : null}
          </figure>
        )
      )}
    </article>
  );
};

export default memo(MarkdownRenderer);
