import { FileArchive, FileText, Folder } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { createFileObjectUrl } from '../../../services/projects/projectSource.ts';
import type { FileData } from '../../../types.ts';
import type { ResolvedLessonSourceReference } from '../../../utils/context/sourceMaterial.ts';

const formatPageRange = ({
  pageEnd,
  pageStart,
}: Pick<ResolvedLessonSourceReference, 'pageEnd' | 'pageStart'>): string | null => {
  if (pageStart === undefined) {
    return null;
  }
  return pageEnd !== undefined && pageEnd !== pageStart
    ? t('Pagine {pageStart}-{pageEnd}', { pageEnd, pageStart })
    : t('Pagina {pageStart}', { pageStart });
};

const buildSourceViewerUrl = (objectUrl: string, pageStart?: number): string => {
  const pageFragment = pageStart === undefined ? '' : `#page=${pageStart}`;
  return `${objectUrl}${pageFragment}`;
};

function DocumentSourceLink({
  loadSourceFile,
  source,
}: Readonly<{
  loadSourceFile?: (sourceId: string) => Promise<FileData | null>;
  source: ResolvedLessonSourceReference;
}>) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const objectUrls = useRef(new Set<string>());

  useEffect(() => {
    const trackedObjectUrls = objectUrls.current;
    return () => {
      for (const trackedObjectUrl of trackedObjectUrls) {
        URL.revokeObjectURL(trackedObjectUrl);
      }
      trackedObjectUrls.clear();
    };
  }, []);

  const pageRange = formatPageRange(source);
  const SourceIcon = source.kind === 'archive' ? FileArchive : FileText;
  const canOpenSource = Boolean(source.file.data || loadSourceFile);
  const openSource = async () => {
    if (!canOpenSource || isLoading) {
      return;
    }
    const viewerWindow = window.open('about:blank', '_blank');
    if (!viewerWindow) {
      setLoadFailed(true);
      return;
    }
    viewerWindow.opener = null;
    setIsLoading(true);
    setLoadFailed(false);
    try {
      let file: FileData | null = source.file.data ? source.file : null;
      if (!file && loadSourceFile) {
        file = await loadSourceFile(source.sourceId);
      }
      const nextObjectUrl = file ? createFileObjectUrl(file) : null;
      if (!nextObjectUrl) {
        viewerWindow.close();
        setLoadFailed(true);
        return;
      }
      objectUrls.current.add(nextObjectUrl);
      viewerWindow.location.href = buildSourceViewerUrl(nextObjectUrl, source.pageStart);
    } catch {
      viewerWindow.close();
      setLoadFailed(true);
    } finally {
      setIsLoading(false);
    }
  };

  let sourceControl = (
    <span className="font-semibold text-stone-900 dark:text-stone-100">{source.name}</span>
  );
  if (canOpenSource) {
    sourceControl = (
      <button
        className="font-semibold text-orange-700 underline decoration-orange-300 underline-offset-4 hover:text-orange-900 disabled:cursor-wait disabled:text-stone-500 dark:text-orange-300 dark:hover:text-orange-100 dark:disabled:text-stone-400"
        disabled={isLoading}
        onClick={() => {
          void openSource();
        }}
        type="button"
      >
        {isLoading ? t('Apertura documento...') : source.name}
      </button>
    );
  }

  return (
    <li className="rounded-xl border border-stone-200/80 px-3 py-2.5 dark:border-stone-700">
      <div className="flex min-w-0 items-start gap-2">
        <SourceIcon className="mt-0.5 h-4 w-4 shrink-0 text-orange-700 dark:text-orange-300" />
        <div className="min-w-0 flex-1">
          {sourceControl}
          {loadFailed ? (
            <p className="mt-1 text-xs text-red-700 dark:text-red-300">
              {t('Documento originale non disponibile.')}
            </p>
          ) : null}
          {pageRange ? (
            <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{pageRange}</p>
          ) : null}
          {source.archiveSelectors?.length ? (
            <ul
              aria-label={t('Percorsi usati nella lezione')}
              className="mt-2 space-y-1 text-xs text-stone-600 dark:text-stone-400"
            >
              {source.archiveSelectors.map(selector => (
                <li
                  className="flex min-w-0 items-start gap-1.5"
                  key={`${selector.kind}:${selector.path}`}
                >
                  {selector.kind === 'directory' ? (
                    <Folder className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="break-all">{selector.path}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export default function LessonDocumentSources({
  loadSourceFile,
  sources,
}: Readonly<{
  loadSourceFile?: (sourceId: string) => Promise<FileData | null>;
  sources: ResolvedLessonSourceReference[];
}>) {
  if (sources.length === 0) {
    return null;
  }

  return (
    <section aria-label={t('Materiali originali usati')} className="mt-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
        {t('Materiali originali usati')}
      </p>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {sources.map(source => (
          <DocumentSourceLink
            key={source.sourceId}
            loadSourceFile={loadSourceFile}
            source={source}
          />
        ))}
      </ul>
    </section>
  );
}
