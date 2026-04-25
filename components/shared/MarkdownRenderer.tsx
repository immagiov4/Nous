import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent,
  memo,
  type ReactNode,
  useMemo,
} from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { LessonImageRef, PdfImageAsset, SectionAnnotation } from '../../types';
import { normalizeMarkdownForRendering } from '../../utils/markdown/render.ts';
import { parsePdfContentParts } from '../../utils/pdf/imagePlaceholders';

export interface MarkdownRendererProps {
  content: string;
  className?: string;
  isDarkMode?: boolean;
  onClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  lessonAssetsById?: Record<string, PdfImageAsset>;
  lessonImageRefsById?: Record<string, LessonImageRef>;
  sectionAnnotations?: SectionAnnotation[];
}

interface CodeRendererProps extends HTMLAttributes<HTMLElement> {
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}

const articleClassName = (className: string) =>
  `prose w-full min-w-0 max-w-none break-words [overflow-wrap:anywhere] marker:text-gray-500 dark:marker:text-zinc-400 [&_*]:max-w-full [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-2 [&_.katex-display]:overscroll-x-contain [&_.katex-display]:[-webkit-overflow-scrolling:touch] [&_.katex-display_.katex]:min-w-max max-sm:[&_.katex-display]:text-[0.94em] [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-4 [&_li]:my-1 [&_figure]:not-prose [&_figure]:mx-0 [&_figure_img]:my-0 [&_mark]:bg-orange-200 [&_mark]:text-gray-900 [&_mark]:px-1 [&_mark]:py-0.5 [&_mark]:rounded [&_mark]:mx-0.5 [&_mark]:decoration-clone [&_mark]:box-decoration-clone [&_mark[data-nous-annotation-id]]:cursor-pointer [&_mark[data-lumina-annotation-id]]:cursor-pointer [&_strong_mark]:font-semibold [&_mark_strong]:font-semibold [&_em_mark]:italic [&_mark_em]:italic dark:[&_mark]:bg-amber-700/50 dark:[&_mark]:text-amber-50 ${className}`;

const buildMarkdownComponents = (
  syntaxTheme: { [key: string]: CSSProperties },
  isDarkMode: boolean,
  noteAnnotationIds: Set<string>
) => ({
  code({ inline, className, children }: CodeRendererProps) {
    const match = /language-(\w+)/.exec(className || '');

    return !inline && match ? (
      <div className="my-4 overflow-hidden rounded-lg border border-gray-200 shadow-sm dark:border-zinc-700/80">
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
      <blockquote className="my-2 border-l-4 border-orange-400/70 pl-4 py-2 italic text-gray-700 dark:border-amber-500/70 dark:text-zinc-200">
        {children}
      </blockquote>
    );
  },
  a({ href, children }: { href?: string; children?: ReactNode }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-1 underline-offset-2 hover:opacity-80"
      >
        {children}
      </a>
    );
  },
  mark({
    node: _node,
    children,
    className: _className,
    ...props
  }: ComponentPropsWithoutRef<'mark'> & { children?: ReactNode; node?: unknown }) {
    const annotationId = props['data-nous-annotation-id'] || props['data-lumina-annotation-id'];
    const hasAttachedNote = typeof annotationId === 'string' && noteAnnotationIds.has(annotationId);

    return (
      <mark
        className="mx-0.5 rounded bg-orange-200 px-1 py-0.5 text-gray-900 decoration-clone box-decoration-clone dark:bg-amber-700/50 dark:text-amber-50"
        style={{
          fontStyle: 'inherit',
          fontWeight: 'inherit',
          ...(hasAttachedNote
            ? {
                border: `1.5px dashed ${isDarkMode ? 'rgba(196, 151, 111, 0.9)' : '#8A5A34'}`,
                paddingInline: '0.16em',
                paddingBlock: '0.24em',
                lineHeight: '2.35',
              }
            : null),
        }}
        data-nous-note-attached={hasAttachedNote ? 'true' : undefined}
        {...props}
      >
        {children}
      </mark>
    );
  },
  table({ children }: { children?: ReactNode }) {
    return (
      <div className="my-6 overflow-x-auto rounded-2xl border border-gray-200/80 dark:border-zinc-700/80">
        <table className="m-0 w-full border-collapse text-left text-sm">{children}</table>
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
      <th className="border-b border-gray-200/80 px-4 py-3 font-semibold text-gray-900 dark:border-zinc-700/80 dark:text-gray-100">
        {children}
      </th>
    );
  },
  td({ children }: { children?: ReactNode }) {
    return <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{children}</td>;
  },
});

const MarkdownRenderer = ({
  content,
  className = '',
  isDarkMode = false,
  onClick,
  onContextMenu,
  lessonAssetsById = {},
  lessonImageRefsById = {},
  sectionAnnotations = [],
}: MarkdownRendererProps) => {
  const syntaxTheme = useMemo(
    () =>
      isDarkMode
        ? (oneDark as unknown as { [key: string]: CSSProperties })
        : (oneLight as unknown as { [key: string]: CSSProperties }),
    [isDarkMode]
  );
  const contentParts = useMemo(
    () => parsePdfContentParts(content, lessonAssetsById, lessonImageRefsById),
    [content, lessonAssetsById, lessonImageRefsById]
  );
  const noteAnnotationIds = useMemo(
    () =>
      new Set(
        sectionAnnotations
          .filter(annotation => annotation.note.trim().length > 0)
          .map(annotation => annotation.id)
      ),
    [sectionAnnotations]
  );
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(syntaxTheme, isDarkMode, noteAnnotationIds),
    [syntaxTheme, isDarkMode, noteAnnotationIds]
  );
  const tracedMarkdownParts = useMemo(
    () =>
      contentParts
        .filter(part => part.type === 'markdown')
        .map(part => {
          const normalizedContent = normalizeMarkdownForRendering(part.content);
          return {
            key: part.key,
            normalizedContent,
            rawContent: part.content,
          };
        }),
    [contentParts]
  );
  const normalizedContentByPartKey = useMemo(
    () => new Map(tracedMarkdownParts.map(part => [part.key, part.normalizedContent])),
    [tracedMarkdownParts]
  );

  return (
    <article
      className={articleClassName(className)}
      onClick={onClick}
      onKeyDown={
        onClick ? e => e.key === 'Enter' && onClick(e as unknown as MouseEvent) : undefined
      }
      onContextMenu={onContextMenu}
    >
      {contentParts.map(part =>
        part.type === 'markdown' ? (
          <ReactMarkdown
            key={part.key}
            remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
            rehypePlugins={[rehypeKatex, rehypeRaw]}
            components={markdownComponents}
          >
            {normalizedContentByPartKey.get(part.key) || ''}
          </ReactMarkdown>
        ) : (
          <figure
            key={part.key}
            className="my-10 overflow-hidden rounded-[28px] border border-gray-200/80 bg-white/85 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/85"
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
