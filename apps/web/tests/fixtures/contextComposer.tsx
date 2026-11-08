import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownRenderer from '../../components/shared/MarkdownRenderer';
import WorkspaceReaderOverlays from '../../components/workspace/shell/WorkspaceReaderOverlays';
import { useReaderContext } from '../../hooks/reader/useReaderContext';
import { useWorkspaceDomain } from '../../hooks/workspace/useWorkspaceDomain';
import { useWorkspaceReaderActions } from '../../hooks/workspace/useWorkspaceReaderActions';
import { setAccountLocale } from '../../i18n/uiMessages';
import { createProjectSnapshot } from '../../services/projects/projectSnapshot';
import type { LearningArtifactRenderPayload } from '../../types';
import { applySectionAnnotation } from '../../utils/learning/sectionAnnotations';
import { buildTestLearningPlan, buildTestLesson } from '../helpers/learningPlan';
import '../../styles/app.css';

setAccountLocale('it');
const params = new URLSearchParams(location.search);
const mobile = params.has('mobile');
const dark = params.has('dark');
document.documentElement.classList.toggle('dark', dark);
const passage = 'Collegare un concetto a un esempio';
const markdown = `# Collegare, per ricordare\n\n${passage} aiuta a comprenderlo e a ricordarlo.\n\nQuando studiamo, possiamo partire da un caso che conosciamo già. La nota rimane collegata al passaggio, mentre la domanda si apre nel pannello di risposta.`;
const richAnnotation = params.has('rich')
  ? applySectionAnnotation({
      content: markdown,
      selectedText: passage,
      note: `Un **collegamento concreto** chiarisce la formula $y=mx+b$.\n\n| Simbolo | Significato |\n| --- | --- |\n| $m$ | Pendenza |\n| $b$ | Intercetta |\n\n${'Confronta la nuova idea con un esempio già noto, poi verifica il collegamento. '.repeat(8)}`,
    })
  : null;
const artifacts: LearningArtifactRenderPayload[] = [
  {
    id: 'visual-draft-scene',
    kind: 'scene',
    title: 'Schema sintetico',
    code: '',
    scene: {
      type: 'steps',
      title: 'Collegare le idee',
      body: '',
      note: '',
      quote: '',
      groups: [],
      items: [
        { label: 'Concetto', detail: 'Scegli una idea.', icon: 'point' },
        { label: 'Esempio', detail: 'Collegala a un caso concreto.', icon: 'point' },
      ],
    },
    createdAt: '',
  },
  {
    id: 'visual-draft-image',
    kind: 'image',
    title: 'Immagine sintetica',
    code: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="240" height="160"%3E%3Crect width="240" height="160" fill="%23c2633b"/%3E%3C/svg%3E',
    createdAt: '',
  },
  {
    id: 'visual-draft-html',
    kind: 'html',
    title: 'Esplorazione sintetica',
    code: '<button onclick="this.textContent=\'Collegamento verificato\'">Prova il collegamento</button>',
    createdAt: '',
  },
].map(visual => ({
  visual,
  summary: {
    id: `synthetic:lesson:generated-visual:${visual.id}`,
    kind: 'generated-visual',
    lessonId: 'lesson',
    lessonTitle: 'Collegare',
    projectId: 'synthetic',
    projectTitle: 'Prova sintetica',
    title: visual.title,
    previewMode: 'chip-only',
  },
})) as LearningArtifactRenderPayload[];
const emptyLibrary = {
  attachedContextRefs: [],
  folders: [],
  projects: [],
  loadProjectsById: async () => [],
  tree: {
    descendantProjectIdsByFolderId: {},
    folderById: {},
    placementByProjectId: {},
    rootNodes: [],
  },
};
const noop = () => {};
function Fixture() {
  const domain = useWorkspaceDomain();
  const { hydrateSnapshot } = domain;
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [events, setEvents] = useState<unknown[]>([]);
  const record = (event: unknown) => setEvents(current => [...current, event]);
  useEffect(() => {
    hydrateSnapshot(
      createProjectSnapshot({
        id: 'synthetic',
        activeSectionId: 'lesson',
        learningPlan: buildTestLearningPlan([
          buildTestLesson({
            id: 'lesson',
            title: 'Collegare',
            content: markdown,
            annotations: richAnnotation?.annotations,
          }),
        ]),
      })
    );
  }, [hydrateSnapshot]);
  const context = useReaderContext({
    activeSectionId: domain.activeSectionId,
    contentRef,
    scrollContainerRef: scrollRef,
    isMobileViewport: mobile,
    sectionAnnotations: domain.activeSection?.annotations,
    sectionContent: domain.sectionContent,
  });
  const actions = useWorkspaceReaderActions({
    activeSectionId: domain.activeSectionId,
    advanceActiveSection: async () => 'noop',
    closeContextMenu: context.closeContextMenu,
    completeActiveSection: async () => 'noop',
    contextMenu: context.contextMenu,
    contextMenuScrollTopRef: context.contextMenuScrollTopRef,
    createLessonFromSelection: async input => {
      record({ operation: 'create-lesson', input });
      return { outcome: 'failed' };
    },
    documentIndex: null,
    isMobileViewport: mobile,
    learningPlan: domain.learningPlan,
    notify: message => record({ operation: 'notify', message }),
    openContextAnswer: input => {
      record({ operation: 'ask', input });
      context.openContextAnswer(input);
    },
    openExercise: async () => {},
    openSection: async () => {},
    patchSectionAnnotations: async (lessonId, annotations, content, generatedVisuals) => {
      record({ operation: 'patch', lessonId, annotations, content, generatedVisuals });
      return true;
    },
    projectId: 'synthetic',
    regenerateActiveSection: async () => 'loaded',
    sectionContent: domain.sectionContent,
    scrollContainerRef: scrollRef,
    setIsMobileSidebarOpen: noop,
    source: null,
    updateSection: domain.updateSection,
  });
  const openSelection = () => {
    const paragraph = contentRef.current?.querySelector('p');
    const text = paragraph?.firstChild;
    if (!text || !paragraph) throw new Error('Synthetic passage must be mounted');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, passage.length);
    const selection = getSelection();
    if (!selection) throw new Error('Browser selection must exist');
    selection.removeAllRanges();
    selection.addRange(range);
    context.openContextMenuFromSelection(selection, mobile ? 'mobile-sheet' : 'desktop-floating');
  };
  return (
    <div
      ref={scrollRef}
      className="h-dvh overflow-auto bg-[var(--bg-paper)] text-[var(--ink-primary)]"
    >
      <nav className="flex flex-wrap gap-3 p-4 text-sm">
        <button type="button" onClick={openSelection}>
          Seleziona il passaggio sintetico
        </button>
        <button type="button" onClick={context.closeContextAnswer}>
          Chiudi risposta sintetica
        </button>
      </nav>
      <main
        className="mx-auto max-w-3xl px-6 py-8"
        data-domain-ready={Boolean(domain.activeSectionId)}
      >
        <div
          ref={contentRef}
          data-nous-lesson-content-root="true"
          onPointerDownCapture={context.handleContentPointerDownCapture}
        >
          <MarkdownRenderer
            content={domain.sectionContent}
            isDarkMode={dark}
            sectionAnnotations={domain.activeSection?.annotations}
            onClick={context.handleContentClick}
            onContextMenu={context.handleContentContextMenu}
          />
        </div>
      </main>
      <WorkspaceReaderOverlays
        {...context}
        handleContextAnswerResizeStart={context.handleContextAnswerResizeStart}
        isDarkMode={dark}
        isMobileViewport={mobile}
        isContextLoading={false}
        lessonCreationBlockReason={null}
        libraryAssistantDataSource={emptyLibrary}
        currentLessonArtifactPayloads={artifacts}
        onAskContextQuestion={actions.handleContextQuestion}
        onAttachArtifactToAnnotation={actions.handleAttachArtifactToAnnotation}
        onCloseContextAnswer={context.closeContextAnswer}
        onCloseContextMenu={context.closeContextMenu}
        onContextMenuEntranceComplete={context.handleContextMenuEntranceComplete}
        onCreateLesson={actions.handleCreateLesson}
        onDeleteAnnotation={actions.handleDeleteAnnotation}
        onDetachArtifactFromAnnotation={actions.handleDetachArtifactFromAnnotation}
        onHighlight={actions.handleHighlight}
        onOpenLibraryReference={noop}
        onSaveConversationNote={actions.handleSaveConversationNote}
        onUpdateConversationNote={actions.handleUpdateConversationNote}
        onSaveNote={actions.handleSaveNote}
        onSaveArtifactToLesson={actions.handleSaveArtifactToLesson}
        onReplaceArtifactInLesson={actions.handleReplaceArtifactInLesson}
      />
      <output id="callback-log" hidden>
        {JSON.stringify(events)}
      </output>
      <output id="annotation-state" hidden>
        {JSON.stringify(domain.activeSection?.annotations ?? [])}
      </output>
    </div>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root required');
createRoot(root).render(<Fixture />);
