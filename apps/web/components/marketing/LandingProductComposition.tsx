import type { UIMessage } from 'ai';
import { MotionConfig } from 'framer-motion';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  Easing,
  interpolate,
  useCurrentFrame,
  useCurrentScale,
} from 'remotion';
import {
  getAppLocale,
  setRenderingLocaleOverride,
  translateUiMessage as t,
} from '../../i18n/uiMessages.ts';
import type { GenerationProgressSnapshot } from '../../services/openrouter/generationProgress.ts';
import {
  type AudioPanelTab,
  DEFAULT_AUDIO_PANEL_TAB,
  type LearningArtifactRenderPayload,
  type LessonGeneratedVisual,
  type LessonNode,
  type LibraryTree,
  type Message,
  type SavedProjectMeta,
  type SectionAnnotation,
  type SettingsPanelSectionId,
  type VoiceProfileId,
} from '../../types.ts';
import type { SidebarGroup } from '../../utils/reader/workspaceReader.ts';
import { NewHomeView } from '../newHome/NewHomeView.tsx';
import LoadingScreen from '../shared/LoadingScreen.tsx';
import type { ContextAnswerState, WorkspaceReaderShellProps } from '../workspace/shell/types.ts';
import WorkspaceReaderShell from '../workspace/WorkspaceReaderShell.tsx';
import LandingDemoCursor from './LandingDemoCursor.tsx';
import { getScrollOffset, getScrollRange, keepTextInputEndVisible } from './landingDemoMotion.ts';
import {
  DEMO_FPS,
  DEMO_HEIGHT,
  type DemoStage,
  LESSON_ANSWER_END_FRAME,
  LESSON_ANSWER_START_FRAME,
  LESSON_ARTIFACT_DISMISS_FRAME,
  LESSON_ARTIFACT_LOADING_FRAME,
  LESSON_ARTIFACT_PREVIEW_FRAME,
  LESSON_ARTIFACT_READY_FRAME,
  LESSON_ATTACH_DRAFT_END_FRAME,
  LESSON_ATTACH_DRAFT_START_FRAME,
  LESSON_ATTACH_REPLY_END_FRAME,
  LESSON_ATTACH_REPLY_START_FRAME,
  LESSON_ATTACH_SEND_FRAME,
  LESSON_FINAL_ARTIFACT_PREVIEW_FRAME,
  LESSON_FINAL_NOTE_OPEN_FRAME,
  LESSON_FINAL_NOTE_SCROLL_END_FRAME,
  LESSON_FINAL_NOTE_SCROLL_START_FRAME,
  LESSON_FIRST_ANNOTATION_CLICK_FRAME,
  LESSON_FIRST_CHAT_DISMISS_FRAME,
  LESSON_GRAPH_DRAFT_END_FRAME,
  LESSON_GRAPH_DRAFT_START_FRAME,
  LESSON_GRAPH_REPLY_END_FRAME,
  LESSON_GRAPH_REPLY_START_FRAME,
  LESSON_GRAPH_SEND_FRAME,
  LESSON_NOTE_DRAFT_END_FRAME,
  LESSON_NOTE_DRAFT_START_FRAME,
  LESSON_NOTE_REPLY_END_FRAME,
  LESSON_NOTE_REPLY_START_FRAME,
  LESSON_NOTE_SAVED_FRAME,
  LESSON_NOTE_SEND_FRAME,
  LESSON_NOTE_TOOL_FRAME,
  LESSON_NOTE_UPDATED_FRAME,
  LESSON_QUESTION_END_FRAME,
  LESSON_QUESTION_START_FRAME,
  LESSON_SECOND_CHAT_DISMISS_FRAME,
  LESSON_SECOND_CHAT_OPEN_FRAME,
  LESSON_SELECTION_CLICK_FRAME,
  LESSON_SEND_CLICK_FRAME,
  LESSON_UPDATE_NOTE_TOOL_FRAME,
  LIBRARY_ARTIFACT_FRAME,
  LIBRARY_ARTIFACT_PREVIEW_FRAME,
  LIBRARY_FIRST_SEND_FRAME,
  LIBRARY_SECOND_SEND_FRAME,
} from './landingDemoTimeline.ts';

export type { DemoStage } from './landingDemoTimeline.ts';

export interface LandingProductVideoFrameProps extends Record<string, unknown> {
  readonly isCompact: boolean;
  readonly locale?: 'en' | 'it';
  readonly stage: DemoStage;
}

export const DEMO_MOBILE_WIDTH = 390;
export const DEMO_MOBILE_HEIGHT = 750;

const ITALIAN_COURSE_TITLE = 'Psicologia cognitiva: memoria e attenzione';
const ENGLISH_COURSE_TITLE = 'Cognitive psychology: memory and attention';
const DEMO_ANNOTATION_ID = 'demo-attention-note';
const DEMO_ARTIFACT_ID = 'demo-attention-switching';
const SVG_IMAGE_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';
const DEMO_CONTEXT_MENU_ANCHOR_X = 800;
const DEMO_CONTEXT_SELECTION_RECT = { top: 248, left: 720, width: 260, height: 44 };
const DEMO_CONTEXT_MENU_ANCHOR_Y =
  DEMO_CONTEXT_SELECTION_RECT.top + DEMO_CONTEXT_SELECTION_RECT.height;
const DEMO_CONTEXT_HORIZONTAL_BOUNDS = { left: 440, right: 1040 };
const REMOTION_STABILITY_CSS = `
  [data-remotion-render-root],
  [data-remotion-render-root] *,
  [data-remotion-render-root] *::before,
  [data-remotion-render-root] *::after {
    animation: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
    transition: none !important;
  }
`;
type GeneratedVisualArtifactPayload = Extract<
  LearningArtifactRenderPayload,
  { summary: { kind: 'generated-visual' } }
>;

const buildAttentionSwitchingArtifact = (
  isItalian: boolean,
  lessonId: string,
  lessonTitle: string,
  projectTitle: string
): GeneratedVisualArtifactPayload => {
  const copy = isItalian
    ? {
        title: 'Il costo del cambio di contesto',
        kicker: 'PERCHÉ IL MULTITASKING RALLENTA',
        subtitle: 'Il cervello alterna, non parallelizza.',
        taskA: 'Compito A',
        taskB: 'Compito B',
        partialContext: 'Contesto parziale',
        singleTask: 'UN COMPITO ALLA VOLTA',
        singleStart: 'un solo avvio',
        activeContext: 'Contesto attivo',
        workingMemory: 'memoria di lavoro',
        stableContext: 'contesto stabile',
        alternatingTasks: 'DUE COMPITI IN ALTERNANZA',
        again: 'di nuovo…',
        andAgain: 'e ancora…',
        switchingCost: 'COSTO DEL CAMBIO',
        time: 'Tempo →',
        disengagement: 'Disimpegno',
        reorientation: 'Ri-orientamento',
        reconstruction: 'Ricostruzione',
        contextSuffix: 'del contesto',
        resumption: 'Ripresa',
        illustrativeDurations: 'Durate illustrative, non in scala.',
        lineMeaning: 'Altezza della linea = contesto attivo',
      }
    : {
        title: 'The cost of context switching',
        kicker: 'WHY MULTITASKING SLOWS US DOWN',
        subtitle: 'The brain alternates; it does not parallelize.',
        taskA: 'Task A',
        taskB: 'Task B',
        partialContext: 'Partial context',
        singleTask: 'ONE TASK AT A TIME',
        singleStart: 'one start',
        activeContext: 'Active context',
        workingMemory: 'working memory',
        stableContext: 'stable context',
        alternatingTasks: 'TWO ALTERNATING TASKS',
        again: 'again…',
        andAgain: 'and again…',
        switchingCost: 'SWITCHING COST',
        time: 'Time →',
        disengagement: 'Disengage',
        reorientation: 'Reorient',
        reconstruction: 'Rebuild',
        contextSuffix: 'the context',
        resumption: 'Resume',
        illustrativeDurations: 'Illustrative durations, not to scale.',
        lineMeaning: 'Line height = active context',
      };
  const { title } = copy;
  const svgCode = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 760" role="img" aria-label="${title}">
      <rect width="1200" height="760" fill="#FCFAF7"/>
      <text x="140" y="64" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="13" letter-spacing="2.6" fill="#66615B">${copy.kicker}</text>
      <text x="140" y="112" font-family="Georgia,'Times New Roman',serif" font-size="40" fill="#1A1917">${title}</text>
      <text x="140" y="144" font-family="Georgia,'Times New Roman',serif" font-style="italic" font-size="17" fill="#66615B">${copy.subtitle}</text>
      <g font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="13">
        <line x1="140" y1="176" x2="166" y2="176" stroke="#C4622A" stroke-width="3.5" stroke-linecap="round"/><text x="174" y="180" fill="#66615B">${copy.taskA}</text>
        <line x1="268" y1="176" x2="294" y2="176" stroke="#4F6D7A" stroke-width="3.5" stroke-linecap="round"/><text x="302" y="180" fill="#66615B">${copy.taskB}</text>
        <line x1="396" y1="176" x2="422" y2="176" stroke="#8A847C" stroke-width="2.5" stroke-dasharray="6 5" stroke-linecap="round"/><text x="430" y="180" fill="#66615B">${copy.partialContext}</text>
      </g>
      <text x="140" y="220" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="14" font-weight="700" letter-spacing="1.6" fill="#1A1917">${copy.singleTask}</text>
      <rect x="140" y="256" width="110" height="80" fill="#F2ECE3"/><text x="195" y="356" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="13" fill="#66615B">${copy.singleStart}</text>
      <line x1="132" y1="264" x2="132" y2="336" stroke="#E8E2DA"/><path d="M132,258 l-4,8 h8 z" fill="#9A948C"/>
      <text transform="rotate(-90 104 298)" x="104" y="298" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="12" fill="#1A1917">${copy.activeContext}</text>
      <text transform="rotate(-90 120 298)" x="120" y="298" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="10.5" fill="#66615B">${copy.workingMemory}</text>
      <line x1="140" y1="336" x2="1066" y2="336" stroke="#E8E2DA" stroke-width="1.2"/>
      <path d="M140,336 C178,334 206,262 250,256" fill="none" stroke="#C4622A" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"/><path d="M250,256 H1060" fill="none" stroke="#C4622A" stroke-width="3.5" stroke-linecap="round"/>
      <text x="1058" y="242" text-anchor="end" font-family="Georgia,serif" font-style="italic" font-size="14" fill="#66615B">${copy.stableContext}</text>
      <text x="140" y="410" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="14" font-weight="700" letter-spacing="1.6" fill="#1A1917">${copy.alternatingTasks}</text>
      <rect x="340" y="455" width="150" height="200" fill="#F2ECE3"/><rect x="580" y="455" width="150" height="200" fill="#F2ECE3"/><rect x="820" y="455" width="150" height="200" fill="#F2ECE3"/>
      <text x="655" y="472" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="13" fill="#66615B">${copy.again}</text><text x="895" y="472" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="13" fill="#66615B">${copy.andAgain}</text>
      <path d="M340,448 v-6 h150 v6" fill="none" stroke="#66615B" stroke-width="1.2"/><text x="415" y="432" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="12.5" font-weight="700" letter-spacing="1.4" fill="#C4622A">${copy.switchingCost}</text>
      <line x1="132" y1="513" x2="132" y2="655" stroke="#E8E2DA"/><path d="M132,507 l-4,8 h8 z" fill="#9A948C"/>
      <text transform="rotate(-90 104 580)" x="104" y="580" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="12" fill="#1A1917">${copy.activeContext}</text><text transform="rotate(-90 120 580)" x="120" y="580" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="10.5" fill="#66615B">${copy.workingMemory}</text>
      <line x1="140" y1="655" x2="1062" y2="655" stroke="#CFC8BE" stroke-width="1.2"/><path d="M1072,655 l-9,-4.5 v9 z" fill="#9A948C"/><text x="1060" y="692" text-anchor="end" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="13" fill="#66615B">${copy.time}</text>
      <path d="M140,655 C178,653 206,511 250,505" fill="none" stroke="#C4622A" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"/><path d="M250,505 H340" fill="none" stroke="#C4622A" stroke-width="3.5" stroke-linecap="round"/><line x1="340" y1="505" x2="354" y2="653" stroke="#C4622A" stroke-width="2.5"/><line x1="358" y1="655" x2="380" y2="655" stroke="#8A847C" stroke-width="2.5" stroke-dasharray="1 6"/>
      <path d="M380,655 C418,653 446,511 490,505" fill="none" stroke="#4F6D7A" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"/><path d="M490,505 H580" fill="none" stroke="#4F6D7A" stroke-width="3.5"/><line x1="580" y1="505" x2="594" y2="653" stroke="#4F6D7A" stroke-width="2.5"/><line x1="598" y1="655" x2="620" y2="655" stroke="#8A847C" stroke-width="2.5" stroke-dasharray="1 6"/>
      <path d="M620,655 C658,653 686,511 730,505" fill="none" stroke="#C4622A" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"/><path d="M730,505 H820" fill="none" stroke="#C4622A" stroke-width="3.5"/><line x1="820" y1="505" x2="834" y2="653" stroke="#C4622A" stroke-width="2.5"/><line x1="838" y1="655" x2="860" y2="655" stroke="#8A847C" stroke-width="2.5" stroke-dasharray="1 6"/>
      <path d="M860,655 C898,653 926,511 970,505" fill="none" stroke="#4F6D7A" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"/><path d="M970,505 H1060" fill="none" stroke="#4F6D7A" stroke-width="3.5"/>
      <g font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="15" font-weight="700" text-anchor="middle"><text x="295" y="493" fill="#C4622A">A</text><text x="535" y="493" fill="#4F6D7A">B</text><text x="775" y="493" fill="#C4622A">A</text><text x="1015" y="493" fill="#4F6D7A">B</text></g>
      <circle cx="347" cy="579" r="9" fill="#FCFAF7" stroke="#C4622A" stroke-width="1.5"/><text x="347" y="583" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="11" font-weight="700" fill="#C4622A">1</text><text x="330" y="583" text-anchor="end" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="14" fill="#1A1917">${copy.disengagement}</text>
      <circle cx="368" cy="655" r="9" fill="#FCFAF7" stroke="#4F6D7A" stroke-width="1.5"/><text x="368" y="659" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="11" font-weight="700" fill="#4F6D7A">2</text><text x="368" y="690" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="14" fill="#1A1917">${copy.reorientation}</text>
      <circle cx="431" cy="582" r="9" fill="#FCFAF7" stroke="#4F6D7A" stroke-width="1.5"/><text x="431" y="586" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="11" font-weight="700" fill="#4F6D7A">3</text><text x="452" y="580" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="14" fill="#1A1917">${copy.reconstruction}</text><text x="452" y="598" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="14" fill="#1A1917">${copy.contextSuffix}</text>
      <circle cx="490" cy="505" r="9" fill="#FCFAF7" stroke="#4F6D7A" stroke-width="1.5"/><text x="490" y="509" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="11" font-weight="700" fill="#4F6D7A">4</text><text x="490" y="479" text-anchor="middle" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="14" fill="#1A1917">${copy.resumption}</text>
      <line x1="140" y1="722" x2="1060" y2="722" stroke="#E8E2DA"/><text x="140" y="744" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="11" letter-spacing="0.4" fill="#66615B">${copy.illustrativeDurations}</text><text x="1060" y="744" text-anchor="end" font-family="'Helvetica Neue','Segoe UI',Arial,sans-serif" font-size="11" letter-spacing="0.4" fill="#66615B">${copy.lineMeaning}</text>
    </svg>`;
  const visual: LessonGeneratedVisual = {
    id: DEMO_ARTIFACT_ID,
    title,
    kind: 'image',
    createdAt: '2026-07-10T12:00:00.000Z',
    altText: isItalian
      ? 'Confronto tra attenzione su un solo compito e cambio continuo tra attività.'
      : 'Comparison between focusing on one task and frequently switching between tasks.',
    code: `${SVG_IMAGE_DATA_URL_PREFIX}${encodeURIComponent(svgCode)}`,
  };

  return {
    summary: {
      id: DEMO_ARTIFACT_ID,
      kind: 'generated-visual',
      lessonId,
      lessonTitle,
      previewMode: 'thumbnail',
      projectId: DEMO_PROJECT_ID,
      projectTitle,
      sourceLabel: isItalian ? 'Generato dal follow-up' : 'Generated from the follow-up',
      title,
    },
    visual,
  };
};
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

const DEMO_PROJECT_ID = 'marketing-preview-cognitive-psychology';
const DEMO_NETWORKS_PROJECT_ID = 'marketing-preview-networks';
const DEMO_FOLDER_ID = 'marketing-preview-folder';
const DEMO_DATE = '2026-07-10T12:00:00.000Z';

const buildDemoProjects = (isItalian: boolean): SavedProjectMeta[] => {
  const sharedProject = {
    sourceKind: 'document' as const,
    createdAt: DEMO_DATE,
    updatedAt: DEMO_DATE,
    lastOpenedAt: DEMO_DATE,
    hasSourceFile: true,
    coverLabel: 'PDF',
  };

  return [
    {
      ...sharedProject,
      id: DEMO_PROJECT_ID,
      title: isItalian ? ITALIAN_COURSE_TITLE : ENGLISH_COURSE_TITLE,
      lessonCount: 12,
      completedCount: 7,
      exerciseCount: 4,
      completedExercises: 3,
    },
    {
      ...sharedProject,
      id: DEMO_NETWORKS_PROJECT_ID,
      title: isItalian
        ? 'Reti: comunicazione e Internet'
        : 'Networks: communication and the Internet',
      lessonCount: 23,
      completedCount: 8,
      exerciseCount: 6,
      completedExercises: 2,
    },
    {
      ...sharedProject,
      id: 'marketing-preview-statistics',
      title: isItalian ? 'Statistica per le scienze sociali' : 'Statistics for social sciences',
      lessonCount: 16,
      completedCount: 4,
      exerciseCount: 8,
      completedExercises: 1,
    },
    {
      ...sharedProject,
      id: 'marketing-preview-philosophy',
      title: isItalian ? 'Filosofia della scienza' : 'Philosophy of science',
      lessonCount: 10,
      completedCount: 2,
      exerciseCount: 3,
      completedExercises: 0,
    },
  ];
};

const buildDemoLibraryTree = (projects: SavedProjectMeta[], isItalian: boolean): LibraryTree => ({
  descendantProjectIdsByFolderId: {
    [DEMO_FOLDER_ID]: projects.map(project => project.id),
  },
  folderById: {
    [DEMO_FOLDER_ID]: {
      id: DEMO_FOLDER_ID,
      name: isItalian ? 'Università' : 'University',
      parentFolderId: null,
      createdAt: DEMO_DATE,
      updatedAt: DEMO_DATE,
      order: 0,
    },
  },
  placementByProjectId: {
    ...Object.fromEntries(
      projects.map((project, order) => [
        project.id,
        { projectId: project.id, folderId: DEMO_FOLDER_ID, order, updatedAt: DEMO_DATE },
      ])
    ),
  },
  rootNodes: [
    {
      id: DEMO_FOLDER_ID,
      kind: 'folder',
      order: 0,
      folder: {
        id: DEMO_FOLDER_ID,
        name: isItalian ? 'Università' : 'University',
        parentFolderId: null,
        createdAt: DEMO_DATE,
        updatedAt: DEMO_DATE,
        order: 0,
      },
      descendantProjectIds: projects.map(project => project.id),
      children: projects.map((project, order) => ({
        id: project.id,
        kind: 'project' as const,
        order,
        project,
      })),
    },
  ],
});

const resolvedVoid = async () => undefined;
const resolvedFalse = async () => false;
const resolvedTrue = async () => true;
const resolvedNull = async () => null;
const resolvedEmptyArray = async () => [];
const rejectDemoCoverLoad = async (): Promise<never> => {
  throw new Error('Course cover storage is unavailable while rendering the product demo.');
};

const DemoNewHomeView = ({
  frame,
  height,
  isItalian,
  portalContainer,
  stage,
}: {
  frame: number;
  height: number;
  isItalian: boolean;
  portalContainer?: HTMLElement | null;
  stage: 'library' | 'plan';
}) => {
  const projects = useMemo(() => buildDemoProjects(isItalian), [isItalian]);
  const libraryTree = useMemo(
    () => buildDemoLibraryTree(projects, isItalian),
    [isItalian, projects]
  );
  const pageOffset = 0;
  const targetHighlightOpacity = 0;
  const pendingFileName =
    stage === 'plan' && frame >= 52 && frame < 170
      ? isItalian
        ? 'Psicologia cognitiva — memoria e attenzione.pdf'
        : 'Cognitive psychology — memory and attention.pdf'
      : null;
  const courseObjective = isItalian
    ? 'Voglio capire come attenzione e memoria influenzano l’apprendimento, partendo dalle basi e con esempi pratici.'
    : 'I want to understand how attention and memory shape learning, starting from the basics with practical examples.';
  const firstAssessmentQuestion = isItalian
    ? 'Da che livello parti? Hai già studiato psicologia generale o questi concetti sono nuovi?'
    : 'What is your starting level? Have you studied general psychology, or are these concepts new?';
  const firstAssessmentAnswer = isItalian
    ? 'Parto quasi da zero. Conosco solo a grandi linee memoria a breve e lungo termine.'
    : 'I am starting almost from zero. I only know the broad distinction between short- and long-term memory.';
  const secondAssessmentQuestion = isItalian
    ? 'Quale risultato concreto vuoi ottenere: preparare un esame, applicare i concetti allo studio o entrambi?'
    : 'What concrete result do you want: prepare for an exam, apply the concepts to studying, or both?';
  const secondAssessmentAnswer = isItalian
    ? 'Entrambi. Ho un esame scritto e voglio anche capire come studiare meglio, con esempi quotidiani e domande di verifica.'
    : 'Both. I have a written exam and also want to study more effectively, with everyday examples and check questions.';
  const assessmentSummary = isItalian
    ? 'Perfetto. Ho livello, obiettivo e stile: preparo un percorso dalle basi, orientato all’esame e con applicazioni pratiche.'
    : 'Perfect. I have your level, goal, and preferred style: I will build a path from the basics, focused on the exam and practical applications.';
  const libraryRecallRequest = isItalian
    ? 'Sto per fare l’esame. Fammi un breve ripasso basato sugli appunti che ho salvato nel corso di Psicologia cognitiva.'
    : 'I am about to take the exam. Give me a brief review based on the notes I saved in the Cognitive Psychology course.';
  const libraryRecallReply = isItalian
    ? [
        'Ho trovato questi appunti nel corso:',
        '',
        '- **Attenzione selettiva:** assegna priorità a una parte degli stimoli disponibili.',
        '- **Memoria di lavoro:** mantiene attive poche informazioni mentre le stai usando.',
        '- **Cambio di contesto:** ogni passaggio richiede disimpegno, ri-orientamento e ricostruzione.',
        '- **Recupero attivo:** provare a ricordare consolida più della sola rilettura.',
      ].join('\n')
    : [
        'I found these notes in the course:',
        '',
        '- **Selective attention:** prioritizes part of the available stimuli.',
        '- **Working memory:** keeps a small amount of information active while you use it.',
        '- **Context switching:** each switch requires disengagement, reorientation, and rebuilding.',
        '- **Active retrieval:** trying to remember strengthens learning more than rereading alone.',
      ].join('\n');
  const libraryArtifactRequest = isItalian
    ? 'Mostrami anche il grafico sull’attenzione che avevo salvato.'
    : 'Also show me the attention chart I saved.';
  const libraryArtifactReply = isItalian
    ? 'Certo. È il grafico che avevi collegato alla nota sul multitasking. Lo riapro qui sotto.'
    : 'Certainly. This is the chart you linked to your multitasking note. I am reopening it below.';
  const objectiveDraft =
    stage === 'library'
      ? frame < LIBRARY_FIRST_SEND_FRAME
        ? getTimelineText(libraryRecallRequest, frame, 24, 112)
        : frame < 320
          ? ''
          : frame < LIBRARY_SECOND_SEND_FRAME
            ? getTimelineText(libraryArtifactRequest, frame, 320, 392)
            : ''
      : stage !== 'plan'
        ? undefined
        : frame < 170
          ? getTimelineText(courseObjective, frame, 70, 145)
          : frame < 360
            ? getTimelineText(firstAssessmentAnswer, frame, 275, 340)
            : frame < 545
              ? getTimelineText(secondAssessmentAnswer, frame, 465, 525)
              : '';
  const assessmentMessages: Message[] = [];

  if (stage === 'plan' && frame >= 170) {
    assessmentMessages.push({ role: 'user', text: courseObjective });
  }

  const firstQuestionStream = getTimelineText(firstAssessmentQuestion, frame, 190, 255);
  if (stage === 'plan' && firstQuestionStream) {
    assessmentMessages.push({ role: 'model', text: firstQuestionStream });
  }

  if (stage === 'plan' && frame >= 360) {
    assessmentMessages.push({ role: 'user', text: firstAssessmentAnswer });
  }

  const secondQuestionStream = getTimelineText(secondAssessmentQuestion, frame, 380, 445);
  if (stage === 'plan' && secondQuestionStream) {
    assessmentMessages.push({ role: 'model', text: secondQuestionStream });
  }

  if (stage === 'plan' && frame >= 545) {
    assessmentMessages.push({ role: 'user', text: secondAssessmentAnswer });
  }

  const assessmentSummaryStream = getTimelineText(assessmentSummary, frame, 565, 625);
  if (stage === 'plan' && assessmentSummaryStream) {
    assessmentMessages.push({ role: 'model', text: assessmentSummaryStream });
  }

  const isAssessmentLoading =
    stage === 'plan' &&
    ((frame >= 170 && frame < 190) ||
      (frame >= 360 && frame < 380) ||
      (frame >= 545 && frame < 565));
  const isAssessmentComplete = stage === 'plan' && frame >= 635;
  const libraryMessages: UIMessage[] = [];
  if (stage === 'library' && frame >= LIBRARY_FIRST_SEND_FRAME) {
    libraryMessages.push({
      id: 'library-recall-request',
      role: 'user',
      parts: [{ type: 'text', text: libraryRecallRequest }],
    });
  }
  const libraryRecallStream = getTimelineText(libraryRecallReply, frame, 155, 292);
  if (stage === 'library' && libraryRecallStream) {
    libraryMessages.push({
      id: 'library-recall-reply',
      role: 'assistant',
      parts: [
        asUiMessagePart({
          type: 'tool-searchLibrary',
          toolCallId: 'library-recall-search',
          state: 'output-available',
          input: {
            query: isItalian ? 'appunti Psicologia cognitiva' : 'Cognitive Psychology notes',
          },
          output: { matches: 4 },
        }),
        {
          type: 'text',
          state: frame >= 292 ? 'done' : 'streaming',
          text: libraryRecallStream,
        },
      ],
    });
  }
  if (stage === 'library' && frame >= LIBRARY_SECOND_SEND_FRAME) {
    libraryMessages.push({
      id: 'library-artifact-request',
      role: 'user',
      parts: [{ type: 'text', text: libraryArtifactRequest }],
    });
  }
  const libraryArtifactReplyStream = getTimelineText(libraryArtifactReply, frame, 435, 492);
  if (stage === 'library' && libraryArtifactReplyStream) {
    libraryMessages.push({
      id: 'library-artifact-reply',
      role: 'assistant',
      parts: [
        ...(frame >= LIBRARY_ARTIFACT_FRAME
          ? [
              asUiMessagePart({
                type: 'tool-getLearningArtifacts',
                toolCallId: 'library-saved-attention-artifact',
                state: 'output-available',
                input: { query: isItalian ? 'grafico attenzione' : 'attention chart' },
                output: { found: 1 },
              }),
            ]
          : []),
        {
          type: 'text',
          state: frame >= 492 ? 'done' : 'streaming',
          text: libraryArtifactReplyStream,
        },
      ],
    });
  }
  const libraryArtifact = buildAttentionSwitchingArtifact(
    isItalian,
    'attention-limits',
    isItalian ? 'Perché l’attenzione è limitata' : 'Why attention is limited',
    isItalian ? ITALIAN_COURSE_TITLE : ENGLISH_COURSE_TITLE
  );
  const homeChatScrollProgressOverride =
    stage === 'library'
      ? interpolate(frame, [505, 595], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : stage === 'plan'
        ? interpolate(frame, [170, 655], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })
        : undefined;

  return (
    <div style={{ height, overflow: 'hidden' }}>
      <style>{`[data-drag-id="${DEMO_PROJECT_ID}"] > article { box-shadow: 0 0 0 2px rgba(217, 150, 109, ${targetHighlightOpacity * 0.7}), 0 18px 54px -28px rgba(217, 150, 109, ${targetHighlightOpacity}); }`}</style>
      <div
        style={{
          translate: `0 ${pageOffset}px`,
          transformOrigin: 'center top',
        }}
      >
        <NewHomeView
          chatProps={{
            assessmentComplete: isAssessmentComplete,
            assessmentMessages,
            homeChatMode: stage === 'library' ? 'library-query' : 'new-course',
            isDarkMode: false,
            isLibraryLoading: false,
            isLibraryModeLoading:
              stage === 'library' &&
              ((frame >= LIBRARY_FIRST_SEND_FRAME && frame < 155) ||
                (frame >= LIBRARY_SECOND_SEND_FRAME && frame < 435)),
            isNewCourseLoading: isAssessmentLoading,
            libraryAttachedContextRefs: [],
            libraryArtifactPayloadsByToolCallId:
              stage === 'library' && frame >= LIBRARY_ARTIFACT_FRAME
                ? { 'library-saved-attention-artifact': [libraryArtifact] }
                : {},
            libraryArtifactPreviewIdOverride:
              stage === 'library' && frame >= LIBRARY_ARTIFACT_PREVIEW_FRAME
                ? DEMO_ARTIFACT_ID
                : null,
            libraryArtifactPortalContainer: portalContainer,
            libraryFloatingArtifactPayloads: [],
            libraryErrorMessage: null,
            libraryMessages,
            libraryTree,
            libraryWebSearch: false,
            libraryGenerateArtifacts: false,
            newCourseLoadingStatus: t('Valutazione risposta...'),
            draftValueOverride: objectiveDraft,
            scrollProgressOverride: homeChatScrollProgressOverride,
            pendingFileName,
            onClearPendingFile: () => {},
            onClearLibraryMessages: () => {},
            onContinueAssessment: () => {},
            onConfirmGenerate: () => {},
            onHomeChatModeChange: () => {},
            onLibraryMessageSend: resolvedVoid,
            onLibraryArtifactNoteApprove: resolvedVoid,
            onLibraryArtifactNoteReject: () => {},
            onLibraryArtifactDiscard: () => {},
            onLibraryArtifactRegenerate: resolvedFalse,
            onLibraryArtifactReplace: resolvedVoid,
            onLibraryWebSearchChange: () => {},
            onLibraryGenerateArtifactsChange: () => {},
            onSendAssessmentMessage: resolvedVoid,
            onToggleLibraryContextRef: () => {},
            onUploadSourceClick: () => {},
          }}
          isDarkMode={false}
          isLibraryLoading={false}
          libraryFolders={Object.values(libraryTree.folderById)}
          libraryTree={libraryTree}
          loadProjectCover={rejectDemoCoverLoad}
          loadProjectSource={resolvedNull}
          loadProjectsById={resolvedEmptyArray}
          onCreateFolder={resolvedVoid}
          onConfirmDeleteFolder={resolvedTrue}
          onDeleteFolder={resolvedVoid}
          onDeleteProject={() => {}}
          onExportProject={() => {}}
          onOpenProject={() => {}}
          openingProjectId={null}
          onRenameFolder={resolvedVoid}
          onToggleDarkMode={() => {}}
          projects={projects}
          saveProjectCover={resolvedVoid}
        />
      </div>
    </div>
  );
};

const getTimelineText = (text: string, frame: number, startFrame: number, endFrame: number) => {
  const visibleCharacters = Math.round(
    interpolate(frame, [startFrame, endFrame], [0, text.length], {
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  );
  return text.slice(0, visibleCharacters);
};

const asUiMessagePart = (part: Record<string, unknown>): UIMessage['parts'][number] =>
  part as UIMessage['parts'][number];

const GENERATION_PROGRESS_TIMELINE = [
  { frame: 0, stage: 'sources', revealedStepCount: 1 },
  { frame: 40, stage: 'structure', revealedStepCount: 2 },
  { frame: 82, stage: 'drafting', revealedStepCount: 3 },
  { frame: 97, stage: 'drafting', revealedStepCount: 4 },
  { frame: 112, stage: 'drafting', revealedStepCount: 5 },
  { frame: 127, stage: 'drafting', revealedStepCount: 6 },
  { frame: 140, stage: 'quiz', revealedStepCount: 7 },
  { frame: 178, stage: 'verification', revealedStepCount: 8 },
  { frame: 218, stage: 'ready', revealedStepCount: 9 },
] as const satisfies ReadonlyArray<{
  frame: number;
  revealedStepCount: number;
  stage: GenerationProgressSnapshot['stage'];
}>;

const buildGenerationProgress = (frame: number, isItalian: boolean): GenerationProgressSnapshot => {
  let currentProgress: (typeof GENERATION_PROGRESS_TIMELINE)[number] =
    GENERATION_PROGRESS_TIMELINE[0];
  for (const progressPoint of GENERATION_PROGRESS_TIMELINE) {
    if (frame < progressPoint.frame) {
      break;
    }
    currentProgress = progressPoint;
  }
  const progressSteps = isItalian
    ? [
        'Raccolta dei concetti principali',
        'Mappa delle fonti',
        'Attenzione selettiva',
        'Memoria di lavoro',
        'Carico cognitivo',
        'Recupero attivo',
        'Metacognizione',
        'Applicazioni allo studio',
        'Verifica finale',
      ]
    : [
        'Collecting the main concepts',
        'Mapping the sources',
        'Selective attention',
        'Working memory',
        'Cognitive load',
        'Active retrieval',
        'Metacognition',
        'Study applications',
        'Final review',
      ];
  const { revealedStepCount, stage } = currentProgress;
  const stepOffset = Math.max(0, revealedStepCount - 3);

  return {
    operation: 'plan',
    sections: progressSteps.slice(stepOffset, revealedStepCount),
    stage,
    startedAt: Date.now() - Math.round((frame / 30) * 1_000),
    stepOffset,
    subject: isItalian ? 'Perché l’attenzione è limitata' : 'Why attention is limited',
  };
};

const buildOutlineLesson = (id: string, title: string): LessonNode => ({
  kind: 'lesson',
  id,
  title,
  description: '',
  isCompleted: false,
  type: 'core',
  content: `# ${title}`,
  quiz: [],
});

const buildCourseGroups = (lessons: LessonNode[], isItalian: boolean): SidebarGroup[] => {
  const encodingLessons = [
    buildOutlineLesson(
      'encoding-processes',
      isItalian ? 'Codifica e consolidamento' : 'Encoding and consolidation'
    ),
    buildOutlineLesson('memory-systems', isItalian ? 'I sistemi di memoria' : 'Memory systems'),
  ];
  const studyLessons = [
    lessons[2],
    buildOutlineLesson(
      'spaced-practice',
      isItalian ? 'Distribuire la pratica nel tempo' : 'Spacing practice over time'
    ),
  ];
  const metacognitionLessons = [
    lessons[3],
    buildOutlineLesson(
      'monitoring-understanding',
      isItalian ? 'Controllare la comprensione' : 'Monitoring understanding'
    ),
  ];
  const applicationLessons = [
    buildOutlineLesson(
      'study-strategies',
      isItalian ? 'Strategie per lo studio' : 'Study strategies'
    ),
    buildOutlineLesson(
      'final-synthesis',
      isItalian ? 'Sintesi e piano di ripasso' : 'Synthesis and review plan'
    ),
  ];

  return [
    {
      id: 'attention-module',
      title: isItalian ? '1. Attenzione e carico cognitivo' : '1. Attention and cognitive load',
      sectionDepthById: { 'attention-limits': 0, 'working-memory': 0 },
      sections: lessons.slice(0, 2),
    },
    {
      id: 'encoding-module',
      title: isItalian ? '2. Costruire un ricordo' : '2. Building a memory',
      sectionDepthById: Object.fromEntries(encodingLessons.map(lesson => [lesson.id, 0])),
      sections: encodingLessons,
    },
    {
      id: 'retrieval-module',
      title: isItalian ? '3. Apprendimento e recupero' : '3. Learning and retrieval',
      sectionDepthById: Object.fromEntries(studyLessons.map(lesson => [lesson.id, 0])),
      sections: studyLessons,
    },
    {
      id: 'metacognition-module',
      title: isItalian ? '4. Metacognizione' : '4. Metacognition',
      sectionDepthById: Object.fromEntries(metacognitionLessons.map(lesson => [lesson.id, 0])),
      sections: metacognitionLessons,
    },
    {
      id: 'application-module',
      title: isItalian ? '5. Applicazioni allo studio' : '5. Study applications',
      sectionDepthById: Object.fromEntries(applicationLessons.map(lesson => [lesson.id, 0])),
      sections: applicationLessons,
    },
  ];
};

const resolvedNoteSave = () => Promise.resolve({ merged: false, saved: false });

export const LandingProductVideoFrame = ({
  isCompact,
  locale,
  stage,
}: LandingProductVideoFrameProps) => {
  const [fontRenderHandle] = useState(() => delayRender('Waiting for product UI fonts'));
  const frame = useCurrentFrame();
  const remotionScale = useCurrentScale();
  useLayoutEffect(() => {
    globalThis.window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
  if (locale) {
    setRenderingLocaleOverride(locale);
  }
  const isItalian = (locale ?? getAppLocale()) === 'it';
  const courseTitle = isItalian ? ITALIAN_COURSE_TITLE : ENGLISH_COURSE_TITLE;
  const demoReasoning = isItalian ? buildItalianDemoReasoning() : ENGLISH_DEMO_REASONING;
  const demoLessons = useMemo(
    () => (isItalian ? buildItalianDemoLessons() : ENGLISH_DEMO_LESSONS),
    [isItalian]
  );
  const courseGroups = useMemo(
    () => buildCourseGroups(demoLessons, isItalian),
    [demoLessons, isItalian]
  );
  const [activeSectionId, setActiveSectionId] = useState(demoLessons[0].id);
  const [expandedModuleId, setExpandedModuleId] = useState(courseGroups[0].id);
  const [completedSectionIds, setCompletedSectionIds] = useState<Set<string>>(new Set());
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const isMobileViewport = isCompact;
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
  const demoRootRef = useRef<HTMLDivElement>(null);
  const [contextAnswerMessagesScrollRange, setContextAnswerMessagesScrollRange] = useState(0);
  const [notePreviewScrollRange, setNotePreviewScrollRange] = useState(0);
  const [demoRootElement, setDemoRootElement] = useState<HTMLDivElement | null>(null);
  const setDemoRoot = useCallback((element: HTMLDivElement | null) => {
    demoRootRef.current = element;
    setDemoRootElement(element);
  }, []);

  useEffect(() => {
    let isComplete = false;
    void document.fonts.ready.finally(() => {
      if (!isComplete) {
        isComplete = true;
        continueRender(fontRenderHandle);
      }
    });
    return () => {
      if (!isComplete) {
        isComplete = true;
        continueRender(fontRenderHandle);
      }
    };
  }, [fontRenderHandle]);

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

  const showStage = (_nextStage: DemoStage) => setIsTtsPlaying(false);

  const selectLesson = (lesson: LessonNode) => {
    setActiveSectionId(lesson.id);
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

  const hasActiveLesson = (stage === 'lesson' || stage === 'generation') && Boolean(activeLesson);
  const isGenerating = stage === 'generation';
  const selectedText = isItalian
    ? 'Due compiti chiedono la stessa risorsa.'
    : 'Two tasks need the same resource.';
  const selectionSearchText = isItalian
    ? 'Quando due compiti chiedono la stessa risorsa nello stesso momento'
    : 'When two tasks need the same resource at the same time';
  const contextQuestion = isItalian
    ? 'Puoi cercare online un esempio contemporaneo di cosa succede quando due attività competono per la stessa attenzione?'
    : 'Can you search online for a contemporary example of what happens when two tasks compete for the same attention?';
  const contextResponse = isItalian
    ? 'Ho verificato online: nelle giornate di studio e lavoro, alternare un’attività complessa a notifiche e chat crea un residuo di attenzione sul compito precedente. Ritrovare il filo richiede tempo e aumenta gli errori.'
    : 'I checked online: during study and work, switching between a complex task, notifications, and chats leaves some attention on the previous task. Regaining focus takes time and increases errors.';
  const noteRequest = isItalian
    ? 'Ah, chiaro. Aggiungi alla nota questo collegamento con notifiche e chat.'
    : 'That makes sense. Add this connection with notifications and chats to the note.';
  const noteReply = isItalian
    ? 'Certo. Ti propongo una nota che collega il costo di commutazione a questo esempio contemporaneo.'
    : 'Of course. Here is a note connecting switching cost with this contemporary example.';
  const noteText = isItalian
    ? 'Il multitasking rallenta perché due compiti competono per una capacità attentiva limitata. Negli ambienti contemporanei, alternare un’attività complessa a notifiche e chat lascia un residuo di attenzione sul compito precedente: ritrovare il filo richiede tempo e aumenta gli errori.'
    : 'Multitasking is slower because two tasks compete for limited attentional capacity. In contemporary environments, switching between a complex task, notifications, and chats leaves attention on the previous task: regaining focus takes time and increases errors.';
  const webSearchQuery = isItalian
    ? 'esempio contemporaneo residuo di attenzione notifiche chat cambio di attività'
    : 'contemporary example attention residue notifications chats task switching';
  const graphRequest = isItalian
    ? 'A proposito, puoi creare un piccolo grafico che mostri cosa succede quando l’attenzione passa continuamente tra due compiti?'
    : 'By the way, can you create a small chart showing what happens when attention keeps switching between two tasks?';
  const graphReply = isItalian
    ? 'Sì. Metto a confronto il lavoro utile con il costo di commutazione e l’aumento degli errori.'
    : 'Yes. I will compare useful work with switching cost and the increase in errors.';
  const attachArtifactRequest = isItalian
    ? 'Perfetto, me lo metti anche nella nota?'
    : 'Perfect, can you add it to the note as well?';
  const attachArtifactReply = isItalian
    ? 'Certo, aggiorno la nota collegando il grafico.'
    : 'Of course, I will update the note and attach the chart.';
  const artifactPayload = useMemo(
    () =>
      buildAttentionSwitchingArtifact(isItalian, activeLesson.id, activeLesson.title, courseTitle),
    [activeLesson.id, activeLesson.title, courseTitle, isItalian]
  );
  const annotationSaved = stage === 'lesson' && frame >= LESSON_NOTE_SAVED_FRAME;
  const artifactReady = stage === 'lesson' && frame >= LESSON_ARTIFACT_READY_FRAME;
  const artifactAttached = stage === 'lesson' && frame >= LESSON_NOTE_UPDATED_FRAME;
  const sectionContent = stage === 'lesson' ? activeLesson.content || '' : '';
  const selectionStart = sectionContent.indexOf(selectionSearchText);
  const sectionAnnotations: SectionAnnotation[] =
    annotationSaved && selectionStart >= 0
      ? [
          {
            id: DEMO_ANNOTATION_ID,
            anchor: {
              kind: 'selection',
              selector: {
                end: selectionStart + selectionSearchText.length,
                exact: selectionSearchText,
                prefix: '',
                start: selectionStart,
                suffix: '',
              },
            },
            artifactRefs: artifactAttached
              ? [
                  {
                    artifactId: DEMO_ARTIFACT_ID,
                    kind: 'generated-visual',
                    title: artifactPayload.summary.title,
                  },
                ]
              : [],
            note: noteText,
            createdAt: '2026-07-10T12:00:00.000Z',
            updatedAt: '2026-07-10T12:00:00.000Z',
          },
        ]
      : [];
  const typedContextQuestion = getTimelineText(
    contextQuestion,
    frame,
    LESSON_QUESTION_START_FRAME,
    LESSON_QUESTION_END_FRAME
  );
  const streamedContextResponse = getTimelineText(
    contextResponse,
    frame,
    LESSON_ANSWER_START_FRAME,
    LESSON_ANSWER_END_FRAME
  );
  const initialContextMenuVisible =
    stage === 'lesson' &&
    frame >= LESSON_SELECTION_CLICK_FRAME &&
    frame < LESSON_SEND_CLICK_FRAME + 8;
  const annotationContextMenuVisible =
    stage === 'lesson' &&
    ((frame >= LESSON_FIRST_ANNOTATION_CLICK_FRAME + 5 && frame < LESSON_SECOND_CHAT_OPEN_FRAME) ||
      frame >= LESSON_FINAL_NOTE_OPEN_FRAME);
  const contextMenuVisible = initialContextMenuVisible || annotationContextMenuVisible;
  const contextMenuOpenFrame = initialContextMenuVisible
    ? LESSON_SELECTION_CLICK_FRAME
    : annotationContextMenuVisible
      ? frame < LESSON_SECOND_CHAT_OPEN_FRAME
        ? LESSON_FIRST_ANNOTATION_CLICK_FRAME + 5
        : LESSON_FINAL_NOTE_OPEN_FRAME
      : null;
  const contextMenuMotionProgress =
    contextMenuOpenFrame === null
      ? undefined
      : interpolate(frame, [contextMenuOpenFrame, contextMenuOpenFrame + 8], [0, 1], {
          easing: Easing.bezier(0.16, 1, 0.3, 1),
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });

  useLayoutEffect(() => {
    if (!annotationContextMenuVisible || !demoRootElement) {
      return;
    }

    const notePreview = demoRootElement.querySelector<HTMLElement>(
      '[data-context-menu-target="note-preview-scroll"]'
    );
    if (!notePreview) {
      return;
    }

    const measuredRange = getScrollRange({
      clientHeight: notePreview.clientHeight,
      renderedClientHeight: notePreview.getBoundingClientRect().height,
      remotionScale,
      scrollHeight: notePreview.scrollHeight,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- The render must react to the measured DOM scroll range.
    setNotePreviewScrollRange(currentRange =>
      Math.abs(currentRange - measuredRange) < 0.25 ? currentRange : measuredRange
    );
  }, [annotationContextMenuVisible, demoRootElement, remotionScale]);

  useLayoutEffect(() => {
    if (frame < 0 || !demoRootElement) {
      return;
    }

    demoRootElement
      .querySelectorAll<HTMLInputElement>(
        [
          'input[data-home-chat-target="objective"]',
          'input[data-context-menu-target="input"]',
          'input[data-chat-composer-target="context-answer-input"]',
        ].join(',')
      )
      .forEach(keepTextInputEndVisible);
  }, [demoRootElement, frame]);
  const firstContextAnswerVisible =
    stage === 'lesson' &&
    frame >= LESSON_SEND_CLICK_FRAME + 8 &&
    frame < LESSON_FIRST_CHAT_DISMISS_FRAME;
  const secondContextAnswerVisible =
    stage === 'lesson' &&
    frame >= LESSON_SECOND_CHAT_OPEN_FRAME &&
    frame < LESSON_SECOND_CHAT_DISMISS_FRAME;
  const contextAnswer = firstContextAnswerVisible
    ? ({
        id: 'marketing-context-answer-selection',
        initialQuestion: '',
        lessonContent: sectionContent,
        lessonDescription: activeLesson.description,
        lessonId: activeLesson.id,
        lessonTitle: activeLesson.title,
        projectId: DEMO_PROJECT_ID,
        projectTitle: courseTitle,
        selectedText,
        contextScope: 'selection',
      } satisfies ContextAnswerState)
    : secondContextAnswerVisible
      ? ({
          id: 'marketing-context-answer-annotation',
          initialQuestion: '',
          attachedAnnotationNote: noteText,
          attachedAnnotationText: selectionSearchText,
          lessonContent: sectionContent,
          lessonDescription: activeLesson.description,
          lessonId: activeLesson.id,
          lessonTitle: activeLesson.title,
          projectId: DEMO_PROJECT_ID,
          projectTitle: courseTitle,
          selectedText: selectionSearchText,
          contextScope: 'annotation',
        } satisfies ContextAnswerState)
      : null;
  const noteReplyStream = getTimelineText(
    noteReply,
    frame,
    LESSON_NOTE_REPLY_START_FRAME,
    LESSON_NOTE_REPLY_END_FRAME
  );
  const graphReplyStream = getTimelineText(
    graphReply,
    frame,
    LESSON_GRAPH_REPLY_START_FRAME,
    LESSON_GRAPH_REPLY_END_FRAME
  );
  const attachArtifactReplyStream = getTimelineText(
    attachArtifactReply,
    frame,
    LESSON_ATTACH_REPLY_START_FRAME,
    LESSON_ATTACH_REPLY_END_FRAME
  );
  const firstConversationMessages: UIMessage[] = firstContextAnswerVisible
    ? [
        {
          id: 'marketing-question',
          role: 'user',
          parts: [{ type: 'text', text: contextQuestion }],
        },
        ...(streamedContextResponse
          ? [
              {
                id: 'marketing-answer',
                role: 'assistant' as const,
                parts: [
                  asUiMessagePart({
                    type: 'tool-searchWeb',
                    toolCallId: 'marketing-search-contemporary-attention-example',
                    state: 'output-available',
                    input: {
                      query: webSearchQuery,
                    },
                    output: {
                      query: webSearchQuery,
                      sources: [
                        {
                          title:
                            'Effects of task interruptions caused by notifications from communication applications on strain and performance',
                          url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10244611/',
                        },
                      ],
                      summary: contextResponse,
                      webSearchRequests: 1,
                    },
                  }),
                  {
                    type: 'text' as const,
                    state:
                      frame >= LESSON_ANSWER_END_FRAME ? ('done' as const) : ('streaming' as const),
                    text: streamedContextResponse,
                  },
                ],
              },
            ]
          : []),
        ...(frame >= LESSON_NOTE_SEND_FRAME
          ? [
              {
                id: 'marketing-note-request',
                role: 'user' as const,
                parts: [{ type: 'text' as const, text: noteRequest }],
              },
            ]
          : []),
        ...(noteReplyStream
          ? [
              {
                id: 'marketing-note-answer',
                role: 'assistant' as const,
                parts: [
                  {
                    type: 'text' as const,
                    state:
                      frame >= LESSON_NOTE_REPLY_END_FRAME
                        ? ('done' as const)
                        : ('streaming' as const),
                    text: noteReplyStream,
                  },
                  ...(frame >= LESSON_NOTE_TOOL_FRAME
                    ? [
                        asUiMessagePart({
                          type: 'tool-requestAddToNotes',
                          toolCallId: 'marketing-save-note',
                          state:
                            frame >= LESSON_NOTE_SAVED_FRAME
                              ? 'output-available'
                              : 'input-available',
                          input: {
                            noteDraft: noteText,
                            rationale: isItalian
                              ? 'Conserva l’esempio contemporaneo che collega il limite attentivo a notifiche e chat.'
                              : 'Keep the contemporary example that connects limited attention with notifications and chats.',
                            selectedTextDraft: selectionSearchText,
                          },
                          ...(frame >= LESSON_NOTE_SAVED_FRAME
                            ? {
                                output: {
                                  approved: true,
                                  mode: 'create',
                                  saved: true,
                                  annotationId: DEMO_ANNOTATION_ID,
                                },
                              }
                            : {}),
                        }),
                      ]
                    : []),
                ],
              },
            ]
          : []),
      ]
    : [];
  const secondConversationMessages: UIMessage[] = secondContextAnswerVisible
    ? [
        {
          id: 'marketing-graph-request',
          role: 'user',
          parts: [{ type: 'text', text: graphRequest }],
        },
        ...(graphReplyStream
          ? [
              {
                id: 'marketing-graph-answer',
                role: 'assistant' as const,
                parts: [
                  {
                    type: 'text' as const,
                    state:
                      frame >= LESSON_GRAPH_REPLY_END_FRAME
                        ? ('done' as const)
                        : ('streaming' as const),
                    text: graphReplyStream,
                  },
                  ...(frame >= LESSON_ARTIFACT_LOADING_FRAME
                    ? [
                        asUiMessagePart({
                          type: 'tool-generateCurrentLessonArtifact',
                          toolCallId: 'marketing-generate-attention-chart',
                          state: artifactReady ? 'output-available' : 'input-available',
                          input: {
                            mode: 'new',
                            prompt: graphRequest,
                          },
                          ...(artifactReady
                            ? {
                                output: {
                                  artifact: artifactPayload.summary,
                                  artifactId: DEMO_ARTIFACT_ID,
                                  artifacts: [artifactPayload.summary],
                                  renderedArtifactCount: 1,
                                },
                              }
                            : {}),
                        }),
                      ]
                    : []),
                ],
              },
            ]
          : []),
        ...(frame >= LESSON_ATTACH_SEND_FRAME
          ? [
              {
                id: 'marketing-attach-request',
                role: 'user' as const,
                parts: [{ type: 'text' as const, text: attachArtifactRequest }],
              },
            ]
          : []),
        ...(attachArtifactReplyStream
          ? [
              {
                id: 'marketing-attach-answer',
                role: 'assistant' as const,
                parts: [
                  {
                    type: 'text' as const,
                    state:
                      frame >= LESSON_ATTACH_REPLY_END_FRAME
                        ? ('done' as const)
                        : ('streaming' as const),
                    text: attachArtifactReplyStream,
                  },
                  ...(frame >= LESSON_UPDATE_NOTE_TOOL_FRAME
                    ? [
                        asUiMessagePart({
                          type: 'tool-requestAddToNotes',
                          toolCallId: 'marketing-update-note',
                          state: artifactAttached ? 'output-available' : 'input-available',
                          input: {
                            artifactIds: [DEMO_ARTIFACT_ID],
                            noteDraft: noteText,
                            rationale: isItalian
                              ? 'Collega il grafico alla nota già salvata.'
                              : 'Attach the chart to the note that is already saved.',
                            selectedTextDraft: selectionSearchText,
                            annotationId: DEMO_ANNOTATION_ID,
                          },
                          ...(artifactAttached
                            ? {
                                output: {
                                  approved: true,
                                  mode: 'update',
                                  saved: true,
                                  annotationId: DEMO_ANNOTATION_ID,
                                },
                              }
                            : {}),
                        }),
                      ]
                    : []),
                ],
              },
            ]
          : []),
      ]
    : [];
  const contextAnswerDisplayMessages = firstContextAnswerVisible
    ? firstConversationMessages
    : secondConversationMessages;
  const contextAnswerInputValue = firstContextAnswerVisible
    ? frame < LESSON_NOTE_SEND_FRAME
      ? getTimelineText(
          noteRequest,
          frame,
          LESSON_NOTE_DRAFT_START_FRAME,
          LESSON_NOTE_DRAFT_END_FRAME
        )
      : ''
    : secondContextAnswerVisible && frame < LESSON_ATTACH_SEND_FRAME
      ? getTimelineText(
          attachArtifactRequest,
          frame,
          LESSON_ATTACH_DRAFT_START_FRAME,
          LESSON_ATTACH_DRAFT_END_FRAME
        )
      : '';
  useLayoutEffect(() => {
    if (!contextAnswer || !demoRootElement) {
      return;
    }

    const messagesContainer = demoRootElement.querySelector<HTMLElement>(
      '[data-context-answer-target="messages-scroll"]'
    );
    if (!messagesContainer) {
      return;
    }

    const measuredRange = getScrollRange({
      clientHeight: messagesContainer.clientHeight,
      renderedClientHeight: messagesContainer.getBoundingClientRect().height,
      remotionScale,
      scrollHeight: messagesContainer.scrollHeight,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- The render must react to the measured DOM scroll range.
    setContextAnswerMessagesScrollRange(currentRange =>
      Math.abs(currentRange - measuredRange) < 0.25 ? currentRange : measuredRange
    );
  }, [contextAnswer, demoRootElement, remotionScale]);
  const contextAnswerScrollProgress = firstContextAnswerVisible
    ? interpolate(frame, [LESSON_NOTE_SEND_FRAME, LESSON_NOTE_TOOL_FRAME + 15], [0, 1], {
        easing: Easing.inOut(Easing.cubic),
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : secondContextAnswerVisible
      ? interpolate(frame, [LESSON_GRAPH_REPLY_START_FRAME, LESSON_ARTIFACT_READY_FRAME], [0, 1], {
          easing: Easing.inOut(Easing.cubic),
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 0;
  const contextAnswerMessagesScrollTopOverride = contextAnswer
    ? getScrollOffset(contextAnswerMessagesScrollRange, contextAnswerScrollProgress)
    : undefined;
  const contextMenuAskInputValue = initialContextMenuVisible
    ? typedContextQuestion
    : annotationContextMenuVisible && frame < LESSON_GRAPH_SEND_FRAME
      ? getTimelineText(
          graphRequest,
          frame,
          LESSON_GRAPH_DRAFT_START_FRAME,
          LESSON_GRAPH_DRAFT_END_FRAME
        )
      : undefined;
  const currentLessonArtifactPayloads = artifactReady ? [artifactPayload] : [];
  const contextAnswerAutoScrollKey = contextAnswer
    ? `${contextAnswer.id}:${Math.floor(frame / 12)}`
    : undefined;
  const generationProgress = buildGenerationProgress(frame, isItalian);

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
      activeSectionGeneratedVisualsById: artifactReady
        ? { [DEMO_ARTIFACT_ID]: artifactPayload.visual }
        : {},
      activeSectionImageRefsById: {},
      activeSectionTitle: hasActiveLesson ? activeLesson.title : null,
      contentRef,
      currentLessonArtifactPayloads,
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
      onSaveLearningAids: async () => true,
      onRemoveExerciseAttachment: () => {},
      onRequestExerciseFeedback: () => {},
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
      sectionAnnotations,
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
      onSaveLearningAids: async () => true,
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
      contextAnswerArtifactActionFeedbackOverride: undefined,
      contextAnswerArtifactPreviewIdOverride:
        frame >= LESSON_ARTIFACT_PREVIEW_FRAME && frame < LESSON_ARTIFACT_DISMISS_FRAME
          ? DEMO_ARTIFACT_ID
          : null,
      contextAnswerArtifactPortalContainer: demoRootElement,
      contextAnswerAutoScrollKey,
      contextAnswer,
      contextAnswerDisplayMessages,
      contextAnswerInputValue,
      contextAnswerMessagesScrollTopOverride,
      contextAnswerPanelRef,
      contextAnswerResizePreviewRef,
      contextAnswerSize: { width: 500, height: 600 },
      contextMenu: annotationContextMenuVisible
        ? {
            type: 'annotation',
            placement: isCompact ? 'mobile-sheet' : 'desktop-floating',
            selectedText: selectionSearchText,
            visible: contextMenuVisible,
            annotationId: DEMO_ANNOTATION_ID,
            annotationArtifactRefs: artifactAttached
              ? [
                  {
                    artifactId: DEMO_ARTIFACT_ID,
                    kind: 'generated-visual',
                    title: artifactPayload.summary.title,
                  },
                ]
              : [],
            annotationNote: noteText,
            anchorX: DEMO_CONTEXT_MENU_ANCHOR_X,
            anchorY: DEMO_CONTEXT_MENU_ANCHOR_Y,
            horizontalBounds: DEMO_CONTEXT_HORIZONTAL_BOUNDS,
            selectionRect: DEMO_CONTEXT_SELECTION_RECT,
            contextBefore: isItalian
              ? 'Il sistema ha capacità limitata. '
              : 'The system has limited capacity. ',
            contextAfter: isItalian
              ? ' Non è una mancanza di volontà.'
              : ' It is not a lack of willpower.',
          }
        : {
            type: 'selection',
            placement: isCompact ? 'mobile-sheet' : 'desktop-floating',
            selectedText,
            visible: contextMenuVisible,
            anchorX: DEMO_CONTEXT_MENU_ANCHOR_X,
            anchorY: DEMO_CONTEXT_MENU_ANCHOR_Y,
            horizontalBounds: DEMO_CONTEXT_HORIZONTAL_BOUNDS,
            selectionRect: DEMO_CONTEXT_SELECTION_RECT,
            contextBefore: isItalian
              ? 'Il sistema ha capacità limitata. '
              : 'The system has limited capacity. ',
            contextAfter: isItalian
              ? ' Non è una mancanza di volontà.'
              : ' It is not a lack of willpower.',
          },
      contextMenuAskInputValue,
      contextMenuArtifactPreviewIdOverride:
        frame >= LESSON_FINAL_ARTIFACT_PREVIEW_FRAME ? DEMO_ARTIFACT_ID : null,
      contextMenuArtifactPortalContainer: demoRootElement,
      contextMenuMotionProgressOverride: contextMenuMotionProgress,
      contextMenuNotePreviewScrollTopOverride:
        frame >= LESSON_FINAL_NOTE_SCROLL_START_FRAME
          ? getScrollOffset(
              notePreviewScrollRange,
              interpolate(
                frame,
                [LESSON_FINAL_NOTE_SCROLL_START_FRAME, LESSON_FINAL_NOTE_SCROLL_END_FRAME],
                [0, 1],
                {
                  easing: Easing.inOut(Easing.cubic),
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                }
              )
            )
          : undefined,
      contextMenuRef,
      handleContextAnswerResizeStart: () => {},
      isContextLoading: false,
      isDarkMode,
      isMobileViewport,
      lessonCreationBlockReason: null,
      currentLessonArtifactPayloads,
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
    <MotionConfig reducedMotion="always" transition={{ duration: 0 }}>
      <AbsoluteFill
        ref={setDemoRoot}
        data-remotion-render-root="true"
        style={{
          backgroundColor: '#fcfaf7',
          overflow: 'hidden',
          transform: 'translateZ(0)',
        }}
      >
        <style>{REMOTION_STABILITY_CSS}</style>
        {stage === 'plan' || stage === 'library' ? (
          <DemoNewHomeView
            frame={frame}
            height={isCompact ? DEMO_MOBILE_HEIGHT : DEMO_HEIGHT}
            isItalian={isItalian}
            portalContainer={demoRootElement}
            stage={stage}
          />
        ) : stage === 'generation' ? (
          <LoadingScreen
            displayMode="embedded"
            elapsedSecondsOverride={Math.floor(frame / DEMO_FPS)}
            isDarkMode={false}
            message={t('Generazione della lezione')}
            progress={generationProgress}
          />
        ) : (
          <div style={{ width: '100%', height: '100%' }}>
            <WorkspaceReaderShell {...shellProps} />
          </div>
        )}

        <LandingDemoCursor
          annotationId={DEMO_ANNOTATION_ID}
          artifactId={DEMO_ARTIFACT_ID}
          frame={frame}
          projectId={DEMO_PROJECT_ID}
          rootRef={demoRootRef}
          selectionSearchText={selectionSearchText}
          stage={stage}
        />
      </AbsoluteFill>
    </MotionConfig>
  );
};
