import { useEffect, useMemo, useState } from 'react';
import { useAppLocale } from '../../../hooks/useAppLocale.ts';
import { setAccountLocale, translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import HomeChatPanel from '../HomeChatPanel.tsx';
import { createDiagnosticDemoAdapter } from './diagnosticDemoAdapter.ts';

const emptyLibrary = {
  descendantProjectIdsByFolderId: {},
  folderById: {},
  placementByProjectId: {},
  rootNodes: [],
};
const ignore = () => undefined;
const ignoreAsync = async () => undefined;

/** Development route, deliberately disconnected from authentication, providers and persistence. */
export default function DiagnosticDemo() {
  useAppLocale();
  const [revision, setRevision] = useState(0);
  const [dark, setDark] = useState(false);
  const [fail, setFail] = useState(false);
  const adapter = useMemo(
    () => ({
      ...createDiagnosticDemoAdapter(fail),
      collectionId: `diagnostic-preview-${revision}`,
    }),
    [fail, revision]
  );
  useEffect(() => {
    setAccountLocale('it');
    return () => setAccountLocale(null);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  return (
    <main className="mx-auto max-w-6xl p-3 sm:p-8">
      <h1 className="my-6 text-center font-serif text-3xl sm:text-5xl">
        Cosa vuoi <span className="text-[var(--accent)]">imparare</span> oggi?
      </h1>
      <HomeChatPanel
        key={`${revision}:${fail}`}
        diagnosticAdapter={adapter}
        assessmentComplete={false}
        assessmentMessages={[]}
        homeChatMode="new-course"
        isDarkMode={dark}
        isLibraryLoading={false}
        isLibraryModeLoading={false}
        isNewCourseLoading={false}
        libraryAttachedContextRefs={[]}
        libraryErrorMessage={null}
        libraryMessages={[]}
        libraryTree={emptyLibrary}
        libraryWebSearch={false}
        libraryGenerateArtifacts={false}
        newCourseLoadingStatus=""
        pendingFileName={null}
        hideHeaderCopy
        hideModeSelector
        onClearPendingFile={ignore}
        onConfirmGenerate={ignore}
        onHomeChatModeChange={ignore}
        onLibraryMessageSend={ignoreAsync}
        onLibraryWebSearchChange={ignore}
        onLibraryGenerateArtifactsChange={ignore}
        onSendAssessmentMessage={ignoreAsync}
        onToggleLibraryContextRef={ignore}
        onUploadSourceClick={ignore}
      />
      <aside aria-label="Controlli prova" className="mt-6 flex flex-wrap gap-4 text-sm">
        <button type="button" onClick={() => setRevision(current => current + 1)}>
          Ricomincia
        </button>
        <label>
          <input type="checkbox" checked={dark} onChange={event => setDark(event.target.checked)} />{' '}
          Tema scuro
        </label>
        <label>
          <input type="checkbox" checked={fail} onChange={event => setFail(event.target.checked)} />{' '}
          {t('Errore al primo invio')}
        </label>
      </aside>
    </main>
  );
}
