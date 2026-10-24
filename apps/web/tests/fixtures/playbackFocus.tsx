import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import LessonPlayer from '../../components/workspace/playback/LessonPlayer';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';
import { setAccountLocale } from '../../i18n/uiMessages';
import '../../styles/app.css';

setAccountLocale('it');
const mobile = new URLSearchParams(location.search).has('mobile');
const content = {
  sectionContent: 'Una lezione di prova.',
  activeSectionTitle: 'Prova del fuoco',
  isDarkMode: false,
  isMobileViewport: mobile,
  activeSectionAssetsById: {},
  activeSectionImageRefsById: {},
} as WorkspaceReaderContentModel;

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <main style={{ height: '200vh', paddingTop: '50vh' }}>
      <button type="button" onClick={() => setOpen(true)}>
        Riproduci
      </button>
      {open ? (
        <LessonPlayer
          projectId="focus-project"
          sectionId="focus-lesson"
          content={content}
          autoPlay={false}
          onClose={() => setOpen(false)}
          tts={{
            currentVoice: 'Kore',
            playbackRate: 1,
            availableVoices: [{ id: 'Kore', label: 'Voce', language: 'it' }],
            onVoiceChange: () => {},
            onSpeedChange: () => {},
          }}
          overlays={{
            contextAnswerSize: { width: 480, height: 400 },
            libraryAssistantDataSource: {
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
            },
            onOpenLibraryReference: () => {},
            onSaveConversationNote: async () => ({
              saved: true,
              merged: false,
              annotationId: 'note',
            }),
            onUpdateConversationNote: async () => ({
              saved: true,
              merged: false,
              annotationId: 'note',
            }),
          }}
        />
      ) : null}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Fixture root required');
createRoot(root).render(<Fixture />);
