import { BookOpen, Clock3, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { READER_MOBILE_LAYOUT_BREAKPOINT_PX } from '../../constants/layout.ts';
import { getAppLocale, translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type AudioPanelTab,
  DEFAULT_AUDIO_PANEL_TAB,
  type LessonNode,
  type SettingsPanelSectionId,
  type VoiceProfileId,
} from '../../types.ts';
import type { SidebarGroup } from '../../utils/reader/workspaceReader.ts';
import type { WorkspaceReaderShellProps } from '../workspace/shell/types.ts';
import WorkspaceReaderShell from '../workspace/WorkspaceReaderShell.tsx';

type DemoStage = 'plan' | 'generation' | 'lesson';

const ITALIAN_COURSE_TITLE = 'Psicologia cognitiva: memoria e attenzione';
const ENGLISH_COURSE_TITLE = 'Cognitive psychology: memory and attention';
const buildItalianDemoReasoning = (): string =>
  [
    'Sto collegando il limite della memoria di lavoro al ruolo dell’attenzione selettiva.',
    'Organizzo la spiegazione dal fenomeno quotidiano al modello cognitivo.',
    t('Inserisco una pausa attiva per verificare la distinzione tra selezione e memoria.'),
  ].join('\n\n');

const ENGLISH_DEMO_REASONING = [
  'I am connecting working-memory limits to the role of selective attention.',
  'I am ordering the explanation from an everyday example to the cognitive model.',
  'I am adding an active pause to check the distinction between selection and memory.',
].join('\n\n');

const buildItalianDemoLessons = (): LessonNode[] => [
  {
    kind: 'lesson',
    id: 'attention-limits',
    title: 'Perché l’attenzione è limitata',
    description: t('Capire il collo di bottiglia che seleziona ciò che elaboriamo.'),
    isCompleted: false,
    type: 'core',
    content: [
      '# Perché l’attenzione è limitata',
      t(
        'In ogni istante arrivano più segnali di quanti il cervello possa elaborare in profondità. L’attenzione risolve questo squilibrio: **seleziona cosa riceverà risorse cognitive** e cosa resterà sullo sfondo.'
      ),
      '## Il collo di bottiglia',
      t(
        'Quando due compiti chiedono la stessa risorsa nello stesso momento, le prestazioni peggiorano. Non è mancanza di volontà: è un limite del sistema. Per questo una lezione efficace riduce le decisioni accessorie e rende evidente il prossimo passo.'
      ),
      '> L’attenzione non registra tutto. Costruisce una priorità temporanea.',
      '## Dalla selezione alla memoria',
      t(
        'Ciò che riceve attenzione ha più probabilità di entrare nella memoria di lavoro. Ripetere, collegare e recuperare attivamente quell’informazione rende poi più stabile la traccia nella memoria a lungo termine.'
      ),
    ].join('\n\n'),
    quiz: [
      {
        question: t('Qual è la funzione principale dell’attenzione in questa lezione?'),
        options: [
          'Registrare ogni stimolo con la stessa precisione',
          'Assegnare priorità alle informazioni da elaborare',
          'Conservare indefinitamente ciò che vediamo',
        ],
        correctIndex: 1,
      },
    ],
  },
  {
    kind: 'lesson',
    id: 'working-memory',
    title: 'La memoria di lavoro',
    description: 'Usare pochi elementi alla volta senza sovraccaricare il sistema.',
    isCompleted: false,
    type: 'core',
    content: [
      '# La memoria di lavoro',
      t(
        'La memoria di lavoro mantiene disponibili, per pochi secondi, le informazioni che stai usando. È lo spazio mentale in cui confronti un esempio con una regola, segui un ragionamento o componi una risposta.'
      ),
      '## Ridurre il carico inutile',
      'Raggruppare concetti collegati e mostrare una sola decisione importante per volta libera risorse per comprendere davvero.',
    ].join('\n\n'),
    quiz: [],
  },
  {
    kind: 'lesson',
    id: 'retrieval-practice',
    title: 'Ricordare attraverso il recupero',
    description: 'Perché provare a ricordare consolida più della rilettura passiva.',
    isCompleted: false,
    type: 'core',
    content: [
      '# Ricordare attraverso il recupero',
      t(
        'Tentare di recuperare una risposta rende la traccia più accessibile. Le domande brevi non sono un’interruzione della lezione: sono parte del processo con cui la conoscenza diventa utilizzabile.'
      ),
    ].join('\n\n'),
    quiz: [],
  },
  {
    kind: 'lesson',
    id: 'metacognition',
    title: 'Studiare con consapevolezza',
    description: 'Distinguere familiarità, comprensione e capacità di spiegare.',
    isCompleted: false,
    type: 'summary',
    content: [
      '# Studiare con consapevolezza',
      'Riconoscere una frase non equivale a saperla spiegare. La metacognizione serve a controllare la qualità reale della comprensione e a scegliere il prossimo passo di studio.',
    ].join('\n\n'),
    quiz: [],
  },
];

const ENGLISH_DEMO_LESSONS: LessonNode[] = [
  {
    kind: 'lesson',
    id: 'attention-limits',
    title: 'Why attention is limited',
    description: 'Understand the bottleneck that selects what we process.',
    isCompleted: false,
    type: 'core',
    content: [
      '# Why attention is limited',
      'At every moment, more signals arrive than the brain can process in depth. Attention resolves this imbalance: it **selects what receives cognitive resources** and what remains in the background.',
      '## The bottleneck',
      'When two tasks need the same resource at the same time, performance drops. It is not a lack of willpower; it is a system limit. An effective lesson therefore reduces secondary decisions and makes the next step obvious.',
      '> Attention does not record everything. It creates a temporary priority.',
      '## From selection to memory',
      'What receives attention is more likely to enter working memory. Repetition, connection, and active retrieval then make that trace more stable in long-term memory.',
    ].join('\n\n'),
    quiz: [
      {
        question: 'What is the main function of attention in this lesson?',
        options: [
          'Record every stimulus with equal precision',
          'Assign priority to the information being processed',
          'Preserve everything we see indefinitely',
        ],
        correctIndex: 1,
      },
    ],
  },
  {
    kind: 'lesson',
    id: 'working-memory',
    title: 'Working memory',
    description: 'Use a few elements at a time without overloading the system.',
    isCompleted: false,
    type: 'core',
    content: [
      '# Working memory',
      'Working memory keeps the information you are using available for a few seconds. It is the mental space where you compare an example with a rule, follow an argument, or compose an answer.',
      '## Reduce unnecessary load',
      'Grouping related concepts and showing one important decision at a time frees resources for real understanding.',
    ].join('\n\n'),
    quiz: [],
  },
  {
    kind: 'lesson',
    id: 'retrieval-practice',
    title: 'Remember through retrieval',
    description: 'Why trying to remember consolidates more than passive rereading.',
    isCompleted: false,
    type: 'core',
    content: [
      '# Remember through retrieval',
      'Trying to retrieve an answer makes the trace more accessible. Short questions are not interruptions: they are part of the process that makes knowledge usable.',
    ].join('\n\n'),
    quiz: [],
  },
  {
    kind: 'lesson',
    id: 'metacognition',
    title: 'Study with awareness',
    description: 'Separate familiarity, understanding, and the ability to explain.',
    isCompleted: false,
    type: 'summary',
    content: [
      '# Study with awareness',
      'Recognizing a sentence is not the same as being able to explain it. Metacognition helps you check the real quality of your understanding and choose the next study step.',
    ].join('\n\n'),
    quiz: [],
  },
];

const buildCourseGroups = (lessons: LessonNode[], isItalian: boolean): SidebarGroup[] => [
  {
    id: 'attention-module',
    title: isItalian ? '1. Attenzione e carico cognitivo' : '1. Attention and cognitive load',
    sectionDepthById: {
      'attention-limits': 0,
      'working-memory': 0,
    },
    sections: lessons.slice(0, 2),
  },
  {
    id: 'memory-module',
    title: isItalian ? '2. Memoria e apprendimento' : '2. Memory and learning',
    sectionDepthById: {
      'retrieval-practice': 0,
      metacognition: 0,
    },
    sections: lessons.slice(2),
  },
];

const resolveInitialMobileViewport = (): boolean =>
  typeof window !== 'undefined' && window.innerWidth < READER_MOBILE_LAYOUT_BREAKPOINT_PX;

const resolvedNoteSave = () => Promise.resolve({ merged: false, saved: false });

export default function LandingProductDemo() {
  const isItalian = getAppLocale() === 'it';
  const courseTitle = isItalian ? ITALIAN_COURSE_TITLE : ENGLISH_COURSE_TITLE;
  const demoReasoning = isItalian ? buildItalianDemoReasoning() : ENGLISH_DEMO_REASONING;
  const demoLessons = useMemo(
    () => (isItalian ? buildItalianDemoLessons() : ENGLISH_DEMO_LESSONS),
    [isItalian]
  );
  const demoStages = [
    ['plan', t('Piano')],
    ['generation', t('Generazione')],
    ['lesson', t('Lezione')],
  ] as const satisfies ReadonlyArray<readonly [DemoStage, string]>;
  const courseGroups = useMemo(
    () => buildCourseGroups(demoLessons, isItalian),
    [demoLessons, isItalian]
  );
  const [stage, setStage] = useState<DemoStage>('lesson');
  const [activeSectionId, setActiveSectionId] = useState(demoLessons[0].id);
  const [expandedModuleId, setExpandedModuleId] = useState(courseGroups[0].id);
  const [completedSectionIds, setCompletedSectionIds] = useState<Set<string>>(new Set());
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(resolveInitialMobileViewport);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [lastAudioTab, setLastAudioTab] = useState<AudioPanelTab>(DEFAULT_AUDIO_PANEL_TAB);
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [musicUrl, setMusicUrl] = useState('');
  const [musicVolume, setMusicVolume] = useState(55);
  const [courseGenerationNotes, setCourseGenerationNotes] = useState('');
  const [settingsPanelExpandedSections, setSettingsPanelExpandedSections] = useState<
    SettingsPanelSectionId[]
  >(['course-notes']);
  const [isTtsPlaying, setIsTtsPlaying] = useState(false);
  const [ttsVoice, setTtsVoice] = useState<VoiceProfileId>('Ara');
  const [ttsChunkIndex, setTtsChunkIndex] = useState(0);
  const [ttsPlaybackRate, setTtsPlaybackRate] = useState(1);
  const [quizAnswersBySection, setQuizAnswersBySection] = useState<Record<string, number[]>>({});

  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contextAnswerPanelRef = useRef<HTMLDivElement>(null);
  const contextAnswerResizePreviewRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleResize = () => setIsMobileViewport(resolveInitialMobileViewport());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const activeLesson = demoLessons.find(lesson => lesson.id === activeSectionId) || demoLessons[0];
  const activeLessonIndex = demoLessons.findIndex(lesson => lesson.id === activeLesson.id);
  const activeSidebarGroup =
    courseGroups.find(group => group.sections.some(section => section.id === activeLesson.id)) ||
    courseGroups[0];
  const quizAnswers = quizAnswersBySection[activeLesson.id] ||
    activeLesson.quiz?.map(() => -1) || [-1];
  const visibleSidebarGroups = useMemo(
    () =>
      courseGroups.map(group => ({
        ...group,
        sections: group.sections.map(section =>
          section.kind === 'lesson'
            ? { ...section, isCompleted: completedSectionIds.has(section.id) }
            : section
        ),
      })),
    [completedSectionIds, courseGroups]
  );

  const showStage = (nextStage: DemoStage) => {
    setStage(nextStage);
    setIsTtsPlaying(false);
    if (nextStage === 'plan') {
      setActiveSectionId('');
      return;
    }
    if (!activeSectionId) {
      setActiveSectionId(demoLessons[0].id);
    }
  };

  const selectLesson = (lesson: LessonNode) => {
    setActiveSectionId(lesson.id);
    setStage('lesson');
    setIsMobileSidebarOpen(false);
    setTtsChunkIndex(0);
  };

  const advanceLesson = () => {
    const nextLesson = demoLessons[activeLessonIndex + 1];
    if (nextLesson) {
      selectLesson(nextLesson);
    }
  };

  const completeLesson = () => {
    setCompletedSectionIds(current => new Set(current).add(activeLesson.id));
  };

  const hasActiveLesson = stage !== 'plan' && Boolean(activeLesson);
  const sectionContent = stage === 'lesson' ? activeLesson.content || '' : '';
  const isGenerating = stage === 'generation';

  const shellProps: WorkspaceReaderShellProps = {
    displayMode: 'embedded',
    banners: {
      needsSourceFile: false,
      onAttachSourceFile: () => {},
      onBackToLibrary: () => showStage('plan'),
      onExportProject: () => {},
      pdfMappingWarning: null,
      storageError: null,
    },
    content: {
      activeSectionAssetsById: {},
      activeSectionGeneratedVisualsById: {},
      activeSectionImageRefsById: {},
      activeSectionTitle: hasActiveLesson ? activeLesson.title : null,
      contentRef,
      currentLessonArtifactPayloads: [],
      hasNextSection: activeLessonIndex < demoLessons.length - 1,
      isDarkMode,
      isFocusMode,
      isLoading: isGenerating,
      isMobileViewport,
      isQuizSubmitted: false,
      learningAids: [],
      onAdvanceSection: advanceLesson,
      onAttachExerciseFiles: () => {},
      onCompleteSection: completeLesson,
      onContentClick: () => {},
      onContentContextMenu: event => event.preventDefault(),
      onContentPointerDownCapture: () => {},
      onDismissLearningAid: () => {},
      onRemoveExerciseAttachment: () => {},
      onSelectQuizAnswer: (questionIndex, optionIndex) => {
        setQuizAnswersBySection(current => {
          const nextAnswers = [...(current[activeLesson.id] || quizAnswers)];
          nextAnswers[questionIndex] = optionIndex;
          return { ...current, [activeLesson.id]: nextAnswers };
        });
      },
      onSetIsQuizSubmitted: () => {},
      onUpdateExerciseInternalText: () => {},
      quiz: stage === 'lesson' ? activeLesson.quiz || [] : [],
      quizAnswers,
      scrollContainerRef,
      sectionAnnotations: [],
      sectionContent,
      sectionReasoningText: isGenerating ? demoReasoning : undefined,
      ttsTextPicker: {
        hoveredChunkIndex: null,
        isActive: false,
        overlayRects: [],
      },
    },
    header: {
      activeSectionId: hasActiveLesson ? activeLesson.id : null,
      activeSectionTitle: hasActiveLesson ? activeLesson.title : null,
      activeSidebarGroup: hasActiveLesson ? activeSidebarGroup : null,
      courseGenerationNotes,
      hasActiveSection: hasActiveLesson,
      isDarkMode,
      isFocusMode,
      isLoading: isGenerating,
      isMobileSidebarOpen,
      isMobileViewport,
      isMusicPlaying,
      isSettingsOpen,
      lastAudioTab,
      learningAids: [],
      learningPlanTitle: courseTitle,
      loadingStatus: isGenerating
        ? isItalian
          ? t('Generazione della lezione')
          : 'Lesson generation'
        : '',
      musicUrl,
      musicVolume,
      onBackToLibrary: () => showStage('plan'),
      onOpenSidebar: () => setIsMobileSidebarOpen(current => !current),
      onRegenerateActiveSection: () => showStage('generation'),
      onDismissLearningAid: () => {},
      onSetCourseGenerationNotes: setCourseGenerationNotes,
      onSetDarkMode: setIsDarkMode,
      onSetFocusMode: setIsFocusMode,
      onSetIsMusicPlaying: setIsMusicPlaying,
      onSetLastAudioTab: setLastAudioTab,
      onSetMusicUrl: setMusicUrl,
      onSetMusicVolume: setMusicVolume,
      onSetSettingsOpen: setIsSettingsOpen,
      onSetSettingsPanelExpandedSections: setSettingsPanelExpandedSections,
      settingsPanelExpandedSections,
      syncState: 'saved',
      tts: {
        availableVoices: [
          { id: 'Ara', label: 'Ara', language: 'it-IT' },
          { id: 'Eve', label: 'Eve', language: 'it-IT' },
        ],
        chunkOptions: [
          {
            index: 0,
            label: isItalian ? t('Parte 1 — Il collo di bottiglia') : 'Part 1 — The bottleneck',
          },
          {
            index: 1,
            label: isItalian
              ? t('Parte 2 — Dalla selezione alla memoria')
              : 'Part 2 — From selection to memory',
          },
        ],
        currentChunkIndex: ttsChunkIndex,
        currentTime: isTtsPlaying ? 42 : 0,
        currentVoice: ttsVoice,
        duration: 286,
        isLoading: false,
        isPlaying: isTtsPlaying,
        isTextPickerActive: false,
        onPlayPause: () => setIsTtsPlaying(current => !current),
        onSeek: () => {},
        onSelectChunk: setTtsChunkIndex,
        onSetTextPickerActive: () => {},
        onSkipChunk: direction =>
          setTtsChunkIndex(current =>
            Math.max(0, Math.min(1, direction === 'next' ? current + 1 : current - 1))
          ),
        onSpeedChange: setTtsPlaybackRate,
        onVoiceChange: setTtsVoice,
        playbackRate: ttsPlaybackRate,
        sectionContent,
        ttsConnected: true,
      },
    },
    overlays: {
      contextAnswer: null,
      contextAnswerPanelRef,
      contextAnswerResizePreviewRef,
      contextAnswerSize: { width: 360, height: 280 },
      contextMenu: {
        type: 'selection',
        placement: 'desktop-floating',
        selectedText: '',
        visible: false,
      },
      contextMenuRef,
      handleContextAnswerResizeStart: () => {},
      isContextLoading: false,
      isDarkMode,
      isMobileViewport,
      onAskContextQuestion: () => {},
      onAttachArtifactToAnnotation: () => {},
      onCloseContextAnswer: () => {},
      onCloseContextMenu: () => {},
      onCreateLesson: () => showStage('generation'),
      onDeleteAnnotation: () => {},
      onDetachArtifactFromAnnotation: () => {},
      onHighlight: () => {},
      onSaveConversationNote: resolvedNoteSave,
      onSaveNote: () => {},
      onUpdateConversationNote: resolvedNoteSave,
    },
    shouldUseDesktopSidebar: !isMobileViewport && !isFocusMode,
    sidebar: {
      activeSectionId: hasActiveLesson ? activeLesson.id : null,
      canRepairApplicationExercises: false,
      expandedModuleId,
      generatingSectionId: isGenerating ? activeLesson.id : null,
      isLoading: isGenerating,
      isMobileViewport,
      isRepairingApplicationExercises: false,
      learningPlanTitle: courseTitle,
      onBackToLibrary: () => showStage('plan'),
      onExportProject: () => {},
      onModuleToggle: groupId =>
        setExpandedModuleId(current => (current === groupId ? '' : groupId)),
      onRepairApplicationExercises: () => {},
      onSelectExercise: () => {},
      onSelectSection: selectLesson,
      onSetFocusMode: setIsFocusMode,
      onSetIsMobileSidebarOpen: setIsMobileSidebarOpen,
      repairApplicationExercisesLabel: 'Pianifica esercizi',
      shouldShowSidebar: isMobileViewport ? isMobileSidebarOpen : !isFocusMode,
      sidebarGroups: visibleSidebarGroups,
    },
  };

  return (
    <div className="marketing-product-demo">
      <div className="marketing-demo-controls">
        <div
          role="tablist"
          aria-label={isItalian ? t('Stati del corso demo') : 'Demo course states'}
        >
          {demoStages.map(([value, label], index) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-label={label}
              aria-selected={stage === value}
              className={stage === value ? 'is-active' : undefined}
              onClick={() => showStage(value)}
            >
              <span>{index + 1}</span>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={`marketing-product-window ${isDarkMode ? 'dark' : ''}`}>
        {stage === 'plan' ? (
          <section className="marketing-demo-library" aria-label={t('Libreria dei corsi')}>
            <header>
              <div>
                <p>{t('Libreria')}</p>
                <h3>{t('Continua da dove avevi lasciato.')}</h3>
              </div>
              <span>{t('1 corso')}</span>
            </header>
            <button
              type="button"
              className="marketing-demo-course"
              onClick={() => selectLesson(demoLessons[0])}
            >
              <span className="marketing-demo-course-icon">
                <BookOpen aria-hidden="true" />
              </span>
              <span className="marketing-demo-course-copy">
                <strong>{courseTitle}</strong>
                <small>{t('4 lezioni · 1 in corso')}</small>
              </span>
              <span className="marketing-demo-course-progress">
                <span>
                  <Clock3 aria-hidden="true" /> {t('Ultimo accesso: oggi')}
                </span>
                <span className="marketing-demo-progress-track" aria-hidden="true">
                  <span />
                </span>
                <small>{t('25% completato')}</small>
              </span>
            </button>
          </section>
        ) : stage === 'generation' ? (
          <section className="marketing-demo-generation" aria-label={t('Costruzione del corso')}>
            <aside>
              <p>{t('Piano del corso')}</p>
              <h3>{courseTitle}</h3>
              <ol>
                {demoLessons.map((lesson, index) => (
                  <li key={lesson.id} className={index === 0 ? 'is-active' : undefined}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    {lesson.title}
                  </li>
                ))}
              </ol>
            </aside>
            <div className="marketing-demo-generation-main">
              <div className="marketing-demo-generation-status">
                <LoaderCircle aria-hidden="true" />
                <div>
                  <p>{t('Lezione 1 di 4')}</p>
                  <h3>{t('Sto preparando “Perché l’attenzione è limitata”')}</h3>
                </div>
              </div>
              <div className="marketing-demo-generation-steps">
                {demoReasoning.split('\n\n').map((step, index) => (
                  <div key={step} className={index === 2 ? 'is-current' : 'is-complete'}>
                    <span>{index < 2 ? '✓' : '•'}</span>
                    <p>{step}</p>
                  </div>
                ))}
              </div>
              <div className="marketing-demo-generation-progress" aria-hidden="true">
                <span />
              </div>
            </div>
          </section>
        ) : (
          <WorkspaceReaderShell {...shellProps} />
        )}
      </div>
    </div>
  );
}
