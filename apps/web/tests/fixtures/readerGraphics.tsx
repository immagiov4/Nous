import { segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { narrationWords } from '@shared/playbackWordTiming';
import { createRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LAB_QUICK_SCENES } from '../../../backend/tests/helpers/lessonSceneLabExamples';
import LessonPlaybackStage from '../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';
import WorkspaceReaderContent from '../../components/workspace/shell/WorkspaceReaderContent';
import '../../styles/app.css';

const options = new URLSearchParams(location.search);
const longLabel =
  'Control trial after recalibration, repeated under the same load to verify that response time stayed within tolerance';
const longRadialLabels = [
  'Eastern measure after the full review of observation methods and local conditions at the start of the trial',
  'Western measure after verification under the same conditions across the full duration of the trial',
];
const empty = { body: '', groups: [], items: [], note: '', quote: '' };
const stages = [
  'Receive the submitted observation',
  'Record the initial conditions',
  'Check the measurement equipment',
  'Repeat the measurement sequence',
  'Does the observation agree?',
  'Record and publish the confirmed observation',
  'Review the measurement setup',
  'Request an independent verification',
];

const flowchart = (dense: boolean): LessonScene => {
  const labels = dense ? stages : ['Observe', 'Does it agree?', 'Keep', 'Review'];
  const decision = dense ? 4 : 1;
  const nodes = labels.map((label, index) => ({
    id: `n${index}`,
    label,
    kind: index === decision ? ('decision' as const) : ('step' as const),
  }));
  const edge = (from: number, to: number, label = '') => ({
    from: nodes[from].id,
    to: nodes[to].id,
    label,
    kind: 'call' as const,
    evidence: '',
  });
  return {
    ...empty,
    type: 'flowchart',
    title: dense ? 'Verify an observation' : 'Check a result',
    diagram: {
      nodes,
      edges: [
        ...nodes.slice(0, decision).map((_, index) => edge(index, index + 1)),
        edge(decision, decision + 1, 'Yes'),
        edge(decision, decision + 2, 'No'),
        ...(dense ? [edge(4, 7, 'Unclear'), edge(6, 3, 'Try again')] : []),
      ],
    },
  };
};

const defaultScenes: LessonScene[] = [
  flowchart(true),
  flowchart(false),
  ...LAB_QUICK_SCENES.filter(scene => ['radar', 'polar', 'scatter'].includes(scene.type)).map(
    scene => {
      if (scene.type !== 'scatter' && options.has('long-radial')) {
        return {
          ...scene,
          items: scene.items.map((item, index) =>
            index === 1 || index === 3
              ? { ...item, label: longRadialLabels[(index - 1) / 2] }
              : item
          ),
        };
      }
      return scene.type === 'scatter'
        ? {
            ...scene,
            items: [
              ...scene.items,
              options.has('long-label')
                ? { label: longLabel, detail: '', icon: '', x: 42, y: 140 }
                : { label: 'External trial', detail: '', icon: '', x: 79, y: 65 },
            ],
          }
        : scene;
    }
  ),
  ...(['network', 'hierarchy'] as const).map(type => ({
    ...empty,
    body: options.has('root-intro') ? 'The branches describe measurements.' : '',
    title: type === 'network' ? 'Weather observations' : 'Observation records',
    type,
    items: [
      { label: 'Wind', detail: 'Direction and speed', icon: 'wind' },
      { label: 'Rain', detail: 'Amount over time', icon: 'droplet' },
      { label: 'Clouds', detail: 'Type and coverage', icon: 'cloud' },
    ],
  })),
];

const scenes =
  (window as Window & { readerGraphicsScenes?: LessonScene[] }).readerGraphicsScenes ??
  defaultScenes;
const isDarkMode = matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark', isDarkMode);
document.body.classList.add('bg-[var(--bg-paper)]');
localStorage.setItem('nous-context-menu-hint-dismissed', 'true');
const noop = () => {};
const sectionContent = 'Inspect the diagrams and measurements in this synthetic lesson.';
const root = document.getElementById('root');
if (!root) throw new Error('Reader fixture is missing its root.');
const contained = options.has('contained');
if (contained) root.classList.add('flex', 'h-dvh', 'flex-col', 'overflow-hidden');

const reader = (
  <WorkspaceReaderContent
    activeSectionAssetsById={{}}
    activeSectionImageRefsById={{}}
    activeSectionGeneratedVisualsById={Object.fromEntries(
      scenes.map((scene, index) => {
        const id = `visual-${index}`;
        return [
          id,
          {
            id,
            slotId: id,
            createdAt: new Date(0).toISOString(),
            render: { kind: 'scene', scene },
          },
        ];
      })
    )}
    activeSectionId="reader-graphics"
    activeSectionTitle="Reader graphics"
    contentRef={createRef()}
    hasFloatingHeader={false}
    hasNextSection={false}
    isDarkMode={isDarkMode}
    isFocusMode={false}
    isLoading={false}
    isMobileViewport={matchMedia('(max-width: 520px)').matches}
    isQuizSubmitted={false}
    onAdvanceSection={noop}
    onAttachExerciseFiles={noop}
    onCompleteSection={noop}
    onContentClick={noop}
    onContentContextMenu={noop}
    onContentPointerDownCapture={noop}
    onRemoveExerciseAttachment={noop}
    onRequestExerciseFeedback={noop}
    onSelectQuizAnswer={noop}
    onSetIsQuizSubmitted={noop}
    onUpdateExerciseInternalText={noop}
    projectId="reader-graphics-fixture"
    quiz={[]}
    quizAnswers={[]}
    scrollContainerRef={createRef()}
    scrollMode={contained ? 'contained' : 'document'}
    sectionContent={sectionContent}
    sectionContentBlocks={[
      { type: 'markdown', markdown: sectionContent },
      ...scenes.map((_, index) => ({
        type: 'generated-visual' as const,
        slotId: `visual-${index}`,
        visualId: `visual-${index}`,
      })),
    ]}
    ttsTextPicker={{ isActive: false, hoveredChunkIndex: null, overlayRects: [] }}
  />
);

const playingScene = scenes.find(scene => scene.type === options.get('playback')) ?? scenes[0];

function ProcessPlayback({ scene }: { scene: LessonScene }) {
  const [position, setPosition] = useState({ time: 0.5, revision: 0 });
  const duration = 12;
  const speech = scene.items.map(item => `${item.label}.`).join(' ');
  const words = narrationWords(speech);
  const onsets = words.map((_, index) => (index * duration) / words.length);
  const sources = [{ type: 'markdown' as const, markdown: speech }];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: {
      scene,
      motion: scene.items.map(({ label }, index) => ({
        effect: 'focus' as const,
        targets: [`item:${index}` as const],
        quote: `${label}.`,
      })),
    },
  };
  return (
    <div className="flex h-dvh flex-col">
      <input
        aria-label="Fixture playback position"
        type="range"
        min={0}
        max={duration}
        step={0.1}
        value={position.time}
        onChange={event =>
          setPosition({ time: event.currentTarget.valueAsNumber, revision: position.revision + 1 })
        }
      />
      <LessonPlaybackStage
        block={block}
        content={{ isDarkMode, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
        alignment={{ status: 'aligned', onsets }}
        duration={duration}
        time={position.time}
        seekRevision={position.revision}
      />
    </div>
  );
}

const fixture = options.has('playback') ? (
  <div style={{ height: '100dvh', display: 'flex' }}>
    <LessonPlaybackStage
      block={{
        id: 'reader-graphics',
        heading: '',
        speech: sectionContent,
        spans: [],
        audio: [],
        visuals: [{ kind: 'scene', scene: playingScene }],
      }}
      content={
        {
          isDarkMode,
          sectionContent,
          sectionContentBlocks: [{ type: 'markdown', markdown: sectionContent }],
        } as WorkspaceReaderContentModel
      }
      duration={10}
      time={5}
    />
  </div>
) : (
  reader
);
createRoot(root).render(
  options.has('process-seek') ? <ProcessPlayback scene={playingScene} /> : fixture
);
