import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import LessonPlayer from '../../components/workspace/playback/LessonPlayer';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';
import { setAccountLocale } from '../../i18n/uiMessages';
import '../../styles/app.css';

setAccountLocale('it');
const layout = new URLSearchParams(location.search).has('layout');
const long = new URLSearchParams(location.search).has('long');
const mobile = new URLSearchParams(location.search).has('mobile');
const content = {
  sectionContent: layout
    ? `# Passaggio sintetico\n\n${long ? 'La descrizione collega ogni passaggio alla figura e mantiene il contesto durante la lettura. '.repeat(12) : 'Una breve spiegazione.'}\n\n{{VISUAL_EXAMPLE:layout-scene}}`
    : 'Una lezione di prova.',
  activeSectionGeneratedVisualsById: layout
    ? {
        'layout-scene': {
          id: 'layout-scene',
          kind: 'scene',
          code: '',
          createdAt: '',
          title: 'Passi sintetici',
          scene: {
            type: 'steps',
            title: 'Passi sintetici',
            body: '',
            quote: '',
            note: '',
            groups: [],
            items: ['Osserva', 'Collega', 'Verifica'].map(label => ({
              label,
              icon: '',
              detail:
                'Una descrizione abbastanza lunga da andare a capo anche nel lettore desktop, senza nascondere alcun passaggio della figura.',
            })),
          },
        },
      }
    : {},
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
