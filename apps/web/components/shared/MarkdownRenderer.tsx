import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type HTMLAttributes,
  isValidElement,
  type MouseEvent,
  memo,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import ReactMarkdown from 'react-markdown';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type {
  LessonImageRef,
  PdfDocumentImageAsset,
  SectionAnnotation,
  StoredLessonVisual,
} from '../../types';
import {
  findSectionAnnotationHighlightHit,
  registerSectionAnnotationHighlights,
  resolveSectionAnnotationHighlightEntries,
  type SectionAnnotationHighlightEntry,
  setSectionAnnotationHighlightHit,
  supportsSectionAnnotationHighlights,
} from '../../utils/learning/sectionAnnotationHighlights.ts';
import { normalizeMarkdownForRendering } from '../../utils/markdown/render.ts';
import { parsePdfContentParts } from '../../utils/pdf/imagePlaceholders';
import GeneratedVisualFrame from './GeneratedVisualFrame.tsx';
import ResolvedPdfImage from './ResolvedPdfImage.tsx';
import SurfaceErrorBoundary from './SurfaceErrorBoundary.tsx';

export interface MarkdownRendererProps {
  readonly content: string;
  readonly className?: string;
  readonly isDarkMode?: boolean;
  readonly onClick?: (e: MouseEvent<HTMLElement>) => void;
  readonly onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
  readonly lessonAssetsById?: Record<string, PdfDocumentImageAsset>;
  readonly generatedVisualsById?: Record<string, StoredLessonVisual>;
  readonly lessonImageRefsById?: Record<string, LessonImageRef>;
  readonly projectId?: string | null;
  readonly sectionAnnotations?: SectionAnnotation[];
}

interface CodeRendererProps extends HTMLAttributes<HTMLElement> {
  readonly className?: string;
  readonly children?: ReactNode;
}

const EMPTY_GENERATED_VISUALS_BY_ID: Record<string, StoredLessonVisual> = {};
const EMPTY_LESSON_ASSETS_BY_ID: Record<string, PdfDocumentImageAsset> = {};
const EMPTY_LESSON_IMAGE_REFS_BY_ID: Record<string, LessonImageRef> = {};
const EMPTY_SECTION_ANNOTATIONS: SectionAnnotation[] = [];
const EMPTY_NOTE_ANNOTATION_IDS = new Set<string>();
const ANNOTATION_HIGHLIGHT_HORIZONTAL_PADDING_PX = 3;
const ANNOTATION_INLINE_HIGHLIGHT_ATTRIBUTE = 'data-nous-annotation-inline-highlight';
const ANNOTATION_NATIVE_BACKED_ATTRIBUTE = 'data-nous-annotation-native-backed';
const ANNOTATION_PERSISTED_MARK_SELECTOR =
  'mark[data-nous-annotation-id], mark[data-lumina-annotation-id]';
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkBreaks];
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex, rehypeRaw];
const NORMALIZED_MARKDOWN_CACHE_LIMIT = 80;

interface AnnotationHighlightLineRect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

const areHighlightRectsOnSameLine = (
  first: AnnotationHighlightLineRect,
  second: DOMRect
): boolean => {
  const firstHeight = first.bottom - first.top;
  const firstCenter = first.top + firstHeight / 2;
  const secondCenter = second.top + second.height / 2;
  return Math.abs(firstCenter - secondCenter) <= Math.min(firstHeight, second.height) / 2;
};

const mergeAnnotationHighlightLineRects = (
  entries: SectionAnnotationHighlightEntry[]
): AnnotationHighlightLineRect[] =>
  entries.flatMap(entry => {
    const rects = entry.ranges
      .flatMap(range => Array.from(range.getClientRects()))
      .filter(rect => rect.width > 0 && rect.height > 0)
      .sort((first, second) => first.top - second.top || first.left - second.left);
    const mergedRects: AnnotationHighlightLineRect[] = [];

    for (const rect of rects) {
      const mergeTargets = mergedRects.filter(candidate =>
        areHighlightRectsOnSameLine(candidate, rect)
      );
      const mergeTarget = mergeTargets[0];
      if (!mergeTarget) {
        mergedRects.push({
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          top: rect.top,
        });
        continue;
      }

      mergeTarget.bottom = Math.max(mergeTarget.bottom, rect.bottom);
      mergeTarget.left = Math.min(mergeTarget.left, rect.left);
      mergeTarget.right = Math.max(mergeTarget.right, rect.right);
      mergeTarget.top = Math.min(mergeTarget.top, rect.top);
      for (const bridgedRect of mergeTargets.slice(1)) {
        mergeTarget.bottom = Math.max(mergeTarget.bottom, bridgedRect.bottom);
        mergeTarget.left = Math.min(mergeTarget.left, bridgedRect.left);
        mergeTarget.right = Math.max(mergeTarget.right, bridgedRect.right);
        mergeTarget.top = Math.min(mergeTarget.top, bridgedRect.top);
        mergedRects.splice(mergedRects.indexOf(bridgedRect), 1);
      }
    }

    return mergedRects;
  });
const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  cs: 'csharp',
  html: 'markup',
  js: 'javascript',
  md: 'markdown',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  xml: 'markup',
  yml: 'yaml',
};
const SUPPORTED_CODE_LANGUAGES = new Set([
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'go',
  'java',
  'javascript',
  'json',
  'jsx',
  'markdown',
  'markup',
  'python',
  'rust',
  'sql',
  'tsx',
  'typescript',
  'yaml',
]);

SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('c', c);
SyntaxHighlighter.registerLanguage('cpp', cpp);
SyntaxHighlighter.registerLanguage('csharp', csharp);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('markup', markup);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('yaml', yaml);

const normalizedMarkdownCache = new Map<string, string>();

const getNormalizedMarkdownForRendering = (content: string): string => {
  const cached = normalizedMarkdownCache.get(content);
  if (cached !== undefined) {
    normalizedMarkdownCache.delete(content);
    normalizedMarkdownCache.set(content, cached);
    return cached;
  }

  const normalized = normalizeMarkdownForRendering(content);
  normalizedMarkdownCache.set(content, normalized);
  if (normalizedMarkdownCache.size > NORMALIZED_MARKDOWN_CACHE_LIMIT) {
    const oldestKey = normalizedMarkdownCache.keys().next().value;
    if (oldestKey !== undefined) {
      normalizedMarkdownCache.delete(oldestKey);
    }
  }

  return normalized;
};

const articleClassName = (className: string) =>
  `prose relative isolate w-full min-w-0 max-w-none break-words [overflow-wrap:anywhere] marker:text-gray-500 dark:marker:text-zinc-400 [&_*]:max-w-full [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-2 [&_.katex-display]:overscroll-x-contain [&_.katex-display]:[-webkit-overflow-scrolling:touch] [&_.katex-display_.katex]:min-w-max max-sm:[&_.katex-display]:text-[0.94em] [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-4 [&_li]:my-1 [&_figure]:not-prose [&_figure]:mx-0 [&_figure_img]:my-0 [&_mark]:bg-orange-200 [&_mark]:text-gray-900 [&_mark[data-nous-annotation-id]]:cursor-pointer [&_mark[data-lumina-annotation-id]]:cursor-pointer [&_strong_mark]:font-semibold [&_mark_strong]:font-semibold [&_em_mark]:italic [&_mark_em]:italic dark:[&_mark]:bg-amber-700/50 dark:[&_mark]:text-amber-50 ${className}`;

const buildMarkdownComponents = (
  syntaxTheme: { [key: string]: CSSProperties },
  isDarkMode: boolean,
  noteAnnotationIds: Set<string>
) => ({
  code({ className, children }: CodeRendererProps) {
    if (className) {
      return <code className={className}>{children}</code>;
    }

    return (
      <code className="inherit-color rounded bg-black/5 px-1.5 py-0.5 text-sm font-mono font-bold dark:bg-white/10">
        {children}
      </code>
    );
  },
  pre({ children }: { children?: ReactNode }) {
    const codeElement = isValidElement<CodeRendererProps>(children) ? children : null;
    const languageLabel = /language-([^\s]+)/
      .exec(codeElement?.props.className || '')?.[1]
      .toLowerCase();
    const language = languageLabel
      ? CODE_LANGUAGE_ALIASES[languageLabel] || languageLabel
      : undefined;

    return language && SUPPORTED_CODE_LANGUAGES.has(language) ? (
      <div className="my-4 overflow-hidden rounded-lg border border-gray-200 shadow-sm dark:border-zinc-700/80">
        <SyntaxHighlighter
          style={syntaxTheme}
          language={language}
          PreTag="pre"
          customStyle={{
            margin: 0,
            padding: '1.5rem',
            fontSize: '0.9rem',
            backgroundColor: isDarkMode ? '#18181b' : '#f9fafb',
          }}
        >
          {String(codeElement?.props.children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      </div>
    ) : (
      <pre className="my-4 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-6 text-sm dark:border-zinc-700/80 dark:bg-zinc-900">
        {children}
      </pre>
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
  mark({ children, ...props }: ComponentPropsWithoutRef<'mark'> & { node?: unknown }) {
    const nousAnnotationId = (props as Record<string, unknown>)['data-nous-annotation-id'];
    const luminaAnnotationId = (props as Record<string, unknown>)['data-lumina-annotation-id'];
    const annotationId = nousAnnotationId || luminaAnnotationId;
    const hasAttachedNote = typeof annotationId === 'string' && noteAnnotationIds.has(annotationId);

    return (
      <mark
        className="bg-orange-200 text-gray-900 dark:bg-amber-700/50 dark:text-amber-50"
        style={{
          backgroundColor: 'var(--annotation-highlight-color)',
          border: 'none',
          borderRadius: '0.14em',
          boxDecorationBreak: 'clone',
          fontStyle: 'inherit',
          fontWeight: 'inherit',
          lineHeight: 'inherit',
          margin: 0,
          padding: '0 3px',
          WebkitBoxDecorationBreak: 'clone',
          ...(hasAttachedNote
            ? {
                textDecorationLine: 'underline',
                textDecorationStyle: 'dashed',
                textUnderlineOffset: '0.18em',
              }
            : null),
        }}
        data-nous-annotation-id={
          typeof nousAnnotationId === 'string' ? nousAnnotationId : undefined
        }
        data-lumina-annotation-id={
          typeof luminaAnnotationId === 'string' ? luminaAnnotationId : undefined
        }
        data-nous-note-attached={hasAttachedNote ? 'true' : undefined}
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

type MarkdownComponents = ReturnType<typeof buildMarkdownComponents>;

interface MarkdownPartProps {
  readonly components: MarkdownComponents;
  readonly content: string;
}

const MarkdownPart = memo(({ components, content }: MarkdownPartProps) => (
  <ReactMarkdown
    remarkPlugins={MARKDOWN_REMARK_PLUGINS}
    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
    components={components}
  >
    {getNormalizedMarkdownForRendering(content)}
  </ReactMarkdown>
));

MarkdownPart.displayName = 'MarkdownPart';

interface PdfImageFigureProps {
  readonly alt: string;
  readonly asset: PdfDocumentImageAsset;
  readonly caption?: string;
  readonly projectId?: string | null;
}

const PdfImageFigure = memo(({ alt, asset, caption, projectId }: PdfImageFigureProps) => (
  <figure
    className="my-10 overflow-hidden rounded-[28px] border border-gray-200/80 bg-white/85 shadow-sm [content-visibility:auto] [contain-intrinsic-size:auto_520px] dark:border-zinc-700/80 dark:bg-zinc-900/85"
    data-nous-speech="ignore"
  >
    <ResolvedPdfImage
      image={asset}
      projectId={projectId}
      alt={alt}
      loading="lazy"
      data-pdf-asset-id={asset.id}
      className="m-0 block w-full bg-gray-50 dark:bg-zinc-950"
    />
    {caption ? (
      <figcaption className="px-5 py-4 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
        {caption}
      </figcaption>
    ) : null}
  </figure>
));

PdfImageFigure.displayName = 'PdfImageFigure';

const MarkdownRenderer = ({
  content,
  className = '',
  isDarkMode = false,
  onClick,
  onContextMenu,
  generatedVisualsById = EMPTY_GENERATED_VISUALS_BY_ID,
  lessonAssetsById = EMPTY_LESSON_ASSETS_BY_ID,
  lessonImageRefsById = EMPTY_LESSON_IMAGE_REFS_BY_ID,
  projectId,
  sectionAnnotations = EMPTY_SECTION_ANNOTATIONS,
}: MarkdownRendererProps) => {
  const articleRef = useRef<HTMLElement>(null);
  const annotationHighlightLayerRef = useRef<HTMLDivElement>(null);
  const annotationHighlightEntriesRef = useRef<SectionAnnotationHighlightEntry[]>([]);
  const usesNativeAnnotationHighlights = supportsSectionAnnotationHighlights();
  const syntaxTheme = useMemo(
    () =>
      isDarkMode
        ? (oneDark as unknown as { [key: string]: CSSProperties })
        : (oneLight as unknown as { [key: string]: CSSProperties }),
    [isDarkMode]
  );
  const contentParts = useMemo(
    () =>
      parsePdfContentParts(content, lessonAssetsById, lessonImageRefsById, generatedVisualsById),
    [content, generatedVisualsById, lessonAssetsById, lessonImageRefsById]
  );
  const noteAnnotationIds = useMemo(
    () =>
      usesNativeAnnotationHighlights
        ? EMPTY_NOTE_ANNOTATION_IDS
        : new Set(
            sectionAnnotations
              .filter(
                annotation =>
                  annotation.note.trim().length > 0 || (annotation.artifactRefs?.length || 0) > 0
              )
              .map(annotation => annotation.id)
          ),
    [sectionAnnotations, usesNativeAnnotationHighlights]
  );
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(syntaxTheme, isDarkMode, noteAnnotationIds),
    [syntaxTheme, isDarkMode, noteAnnotationIds]
  );
  const classNameValue = useMemo(() => articleClassName(className), [className]);
  useLayoutEffect(() => {
    const article = articleRef.current;
    const highlightLayer = annotationHighlightLayerRef.current;
    if (!article || !highlightLayer || !content.trim() || !usesNativeAnnotationHighlights) {
      annotationHighlightEntriesRef.current = [];
      return;
    }

    const entries = resolveSectionAnnotationHighlightEntries(article, sectionAnnotations);
    annotationHighlightEntriesRef.current = entries;
    const unregisterHighlights = registerSectionAnnotationHighlights(entries);
    const resolvedAnnotationIds = new Set(entries.map(entry => entry.annotationId));
    const nativeBackedAnnotationMarks = Array.from(
      article.querySelectorAll<HTMLElement>(ANNOTATION_PERSISTED_MARK_SELECTOR)
    )
      .filter(mark => {
        const annotationId = mark.dataset.nousAnnotationId ?? mark.dataset.luminaAnnotationId;
        return resolvedAnnotationIds.has(annotationId as string);
      })
      .map(mark => ({
        backgroundColor: mark.style.backgroundColor,
        borderRadius: mark.style.borderRadius,
        element: mark,
        padding: mark.style.padding,
      }));
    nativeBackedAnnotationMarks.forEach(({ element }) => {
      element.setAttribute(ANNOTATION_NATIVE_BACKED_ATTRIBUTE, 'true');
      element.style.backgroundColor = 'transparent';
      element.style.borderRadius = '0';
      element.style.padding = '0';
    });
    const highlightedInlineCodeElements = Array.from(
      article.querySelectorAll('code:not(pre code)')
    ).filter(codeElement =>
      entries.some(entry => entry.ranges.some(range => range.intersectsNode(codeElement)))
    );
    highlightedInlineCodeElements.forEach(codeElement => {
      codeElement.setAttribute(ANNOTATION_INLINE_HIGHLIGHT_ATTRIBUTE, 'true');
    });
    const renderHighlightLines = () => {
      const articleRect = article.getBoundingClientRect();
      const fragment = document.createDocumentFragment();
      for (const rect of mergeAnnotationHighlightLineRects(entries)) {
        const lineHighlight = document.createElement('span');
        lineHighlight.className = 'nous-annotation-highlight-line';
        lineHighlight.style.left = `${rect.left - articleRect.left - ANNOTATION_HIGHLIGHT_HORIZONTAL_PADDING_PX}px`;
        lineHighlight.style.top = `${rect.top - articleRect.top}px`;
        lineHighlight.style.width = `${
          rect.right - rect.left + ANNOTATION_HIGHLIGHT_HORIZONTAL_PADDING_PX * 2
        }px`;
        lineHighlight.style.height = `${rect.bottom - rect.top}px`;
        lineHighlight.style.maxWidth = 'none';
        fragment.append(lineHighlight);
      }
      highlightLayer.replaceChildren(fragment);
    };

    renderHighlightLines();
    let isHighlightLayerActive = true;
    void document.fonts?.ready.then(() => {
      if (isHighlightLayerActive) {
        renderHighlightLines();
      }
    });
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(renderHighlightLines);
    resizeObserver?.observe(article);
    return () => {
      isHighlightLayerActive = false;
      resizeObserver?.disconnect();
      highlightLayer.replaceChildren();
      highlightedInlineCodeElements.forEach(codeElement => {
        codeElement.removeAttribute(ANNOTATION_INLINE_HIGHLIGHT_ATTRIBUTE);
      });
      nativeBackedAnnotationMarks.forEach(({ backgroundColor, borderRadius, element, padding }) => {
        element.removeAttribute(ANNOTATION_NATIVE_BACKED_ATTRIBUTE);
        element.style.backgroundColor = backgroundColor;
        element.style.borderRadius = borderRadius;
        element.style.padding = padding;
      });
      unregisterHighlights();
      if (annotationHighlightEntriesRef.current === entries) {
        annotationHighlightEntriesRef.current = [];
      }
    };
  }, [content, sectionAnnotations, usesNativeAnnotationHighlights]);
  const handleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (usesNativeAnnotationHighlights) {
        const hit = findSectionAnnotationHighlightHit(
          annotationHighlightEntriesRef.current,
          event.clientX,
          event.clientY
        );
        if (hit) {
          setSectionAnnotationHighlightHit(event.nativeEvent, hit);
        }
      }
      onClick?.(event);
    },
    [onClick, usesNativeAnnotationHighlights]
  );
  const handleKeyDown = useMemo(
    () =>
      onClick
        ? (e: React.KeyboardEvent) =>
            e.key === 'Enter' && onClick(e as unknown as MouseEvent<HTMLElement>)
        : undefined,
    [onClick]
  );

  return (
    <article
      ref={articleRef}
      className={classNameValue}
      onClick={onClick ? handleClick : undefined}
      onKeyDown={handleKeyDown}
      onContextMenu={onContextMenu}
    >
      <div
        ref={annotationHighlightLayerRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
      />
      {contentParts.map(part =>
        part.type === 'markdown' ? (
          <MarkdownPart key={part.key} content={part.content} components={markdownComponents} />
        ) : part.type === 'image' ? (
          <PdfImageFigure
            key={part.key}
            alt={part.alt}
            asset={part.asset}
            caption={part.caption}
            projectId={projectId}
          />
        ) : (
          <div
            key={part.key}
            className="[content-visibility:auto] [contain-intrinsic-size:auto_520px]"
          >
            <SurfaceErrorBoundary resetKey={part.key} surface="visual">
              <GeneratedVisualFrame
                isDarkMode={isDarkMode}
                projectId={projectId}
                title={part.title}
                visual={part.visual}
              />
            </SurfaceErrorBoundary>
          </div>
        )
      )}
    </article>
  );
};

export default memo(MarkdownRenderer);
