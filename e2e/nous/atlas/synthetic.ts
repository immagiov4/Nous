import {
  LAB_COMPOSITION_SCENE,
  LAB_QUICK_SCENES,
} from '../../../apps/backend/tests/helpers/lessonSceneLabExamples';
import type {
  LessonContentBlock,
  LessonGeneratedVisualKind,
  LessonNode,
  StoredLessonVisual,
} from '../../../apps/web/types';
import type { PlaybackContentBlock } from '../../../packages/shared-types/lessonPlayback';
import {
  findLessonSceneProblems,
  LESSON_SCENE_REGISTRY,
  LESSON_SCENE_TYPES,
  type LessonScene,
  type LessonSceneType,
} from '../../../packages/shared-types/lessonScene';
import { syntheticCourse } from '../syntheticCourse';
import { pairwiseRows } from './pairwise';

const CONTENT_KINDS = [
  'markdown',
  'generated-visual',
  'inline-quiz',
  'youtube-clips',
] as const satisfies readonly PlaybackContentBlock['type'][];
const VISUAL_KINDS = [
  'markdown',
  'scene',
  'html',
  'svg',
  'mermaid',
  'image',
] as const satisfies readonly (LessonGeneratedVisualKind | 'markdown')[];
export const SYNTHETIC_FACTORS = {
  contentKind: CONTENT_KINDS,
  visualKind: VISUAL_KINDS,
  sceneType: LESSON_SCENE_TYPES,
  syntax: ['prose', 'inline-math', 'display-math', 'code', 'annotations', 'quote', 'headings'],
};
const QUOTATION = 'A measured quantity can describe a change.';
const DATE = new Date(0).toISOString();

export function syntheticScene(type: LessonSceneType): LessonScene {
  const authored = LAB_QUICK_SCENES.find(scene => scene.type === type);
  if (authored) return structuredClone(authored);
  if (type === 'composition') return structuredClone(LAB_COMPOSITION_SCENE);
  const items = ['First', 'Second', 'Third'].map((label, index) => ({
    icon: 'point',
    label,
    detail: 'Synthetic explanation.',
    value: index + 1,
    time: index + 1,
  }));
  const groups = ['Option A', 'Option B'].map(label => ({
    label,
    items: ['First', 'Second'],
    icons: ['point', 'point'],
  }));
  let scene: LessonScene = {
    type,
    title: 'Synthetic scene',
    body: '',
    quote: '',
    note: '',
    items,
    groups: [],
  };
  const definition = LESSON_SCENE_REGISTRY[type];
  if ('diagram' in definition && definition.diagram)
    scene = {
      ...scene,
      items: [],
      diagram: {
        nodes: [
          { id: 'first', kind: 'start', label: 'First' },
          { id: 'second', kind: 'end', label: 'Second' },
        ],
        edges: [
          { from: 'first', to: 'second', label: 'Continues', kind: 'event', evidence: QUOTATION },
        ],
      },
    };
  if (['signals', 'comparison', 'matrix', 'decision', 'balance', 'beforeafter'].includes(type))
    scene = {
      ...scene,
      items: [],
      groups,
      body: type === 'decision' ? 'Which option applies?' : '',
      ...(type === 'matrix' ? { criteria: ['First criterion', 'Second criterion'] } : {}),
    };
  if (type === 'quote') scene = { ...scene, items: [], quote: QUOTATION };
  if (type === 'number') scene = { ...scene, items: items.slice(0, 1) };
  if (type === 'proportional')
    scene = {
      ...scene,
      items: [],
      autoplay: true,
      min: 1,
      initial: 1,
      max: 3,
      amountPerUnit: 2,
      inputLabel: 'Quantity',
      unitLabel: 'units',
      outputLabel: 'Total',
      outputUnit: 'points',
      assumption: 'Each unit contributes the same amount.',
    };
  if (type === 'guided-path')
    scene = {
      ...scene,
      items: [],
      autoplay: true,
      steps: [
        { label: 'First', detail: 'Observe the first step.' },
        { label: 'Second', detail: 'Observe the second step.' },
      ],
    };
  const problems = findLessonSceneProblems(scene);
  if (problems.length) throw new Error(`Invalid synthetic scene ${type}: ${problems.join('; ')}`);
  return scene;
}

/** Literal leaves provide deterministic grounding for the authored example scenes. */
function narration(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(narration).join(' ');
  return value && typeof value === 'object' ? Object.values(value).map(narration).join(' ') : '';
}
function syntaxText(kind: string) {
  switch (kind) {
    case 'inline-math':
      return String.raw`The Greek letter $\sigma$ represents the quantity.`;
    case 'display-math':
      return 'The relation is explicit.\n\n$$x = 2y$$\n\nThe result follows the equation.';
    case 'code':
      return 'Use the pre`fix` label.\n\n```ts\nconst result = 1 + 2;\n```';
    case 'annotations':
      return String.raw`The Greek <mark data-nous-annotation-id="first">let</mark><mark data-nous-annotation-id="second">ter</mark> $\sigma$ represents a quantity.`;
    case 'quote':
      return `> ${QUOTATION}`;
    case 'headings':
      return '## First heading\n\nA complete sentence.\n\n### Second heading\n\nAnother complete sentence.';
    default:
      return 'A complete synthetic sentence explains the visual.';
  }
}

export function syntheticPairwiseCourse(imageDataUrl: string) {
  const coverage = pairwiseRows(SYNTHETIC_FACTORS);
  const lessons: LessonNode[] = coverage.rows.map((row, index) => {
    const scene = syntheticScene(row.sceneType as LessonSceneType);
    const evidence = `${QUOTATION} ${narration(scene)}`;
    const markdown = `${syntaxText(row.syntax)}\n\n${evidence}`;
    const sources: LessonContentBlock[] = [{ type: 'markdown', markdown }];
    const visuals: StoredLessonVisual[] = [
      {
        id: 'scene',
        slotId: 'scene-slot',
        createdAt: DATE,
        render: { kind: 'scene', scene },
      },
    ];
    sources.push({ type: 'generated-visual', slotId: 'scene-slot', visualId: 'scene' });
    if (row.visualKind === 'markdown')
      sources.push({
        type: 'markdown',
        markdown: '| Phase | Observation |\n| --- | --- |\n| First | A complete value |',
      });
    else if (row.visualKind !== 'scene') {
      const code = {
        html: '<p>A complete synthetic HTML explanation.</p>',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><text x="10" y="40">Synthetic SVG explanation</text></svg>',
        mermaid: 'flowchart LR\nA[First] --> B[Second]',
        image: imageDataUrl,
      }[row.visualKind as 'html' | 'svg' | 'mermaid' | 'image'];
      visuals.push({
        id: 'visual',
        kind: row.visualKind as Exclude<LessonGeneratedVisualKind, 'scene'>,
        code,
        title: 'Synthetic visual',
        createdAt: DATE,
      });
      sources.push({ type: 'generated-visual', slotId: 'visual-slot', visualId: 'visual' });
    }
    if (row.contentKind === 'inline-quiz')
      sources.push({
        type: 'inline-quiz',
        quiz: {
          question: 'Which observation is stated?',
          options: ['First', 'Second', 'Third', 'Fourth'],
          correctIndex: 0,
          explanation: 'First is explicitly stated.',
        },
      });
    if (row.contentKind === 'youtube-clips')
      sources.push({
        type: 'youtube-clips',
        clips: [{ sourceIndex: 0, startSeconds: 0, endSeconds: 1 }],
      });
    if (row.contentKind === 'markdown')
      sources.push({ type: 'markdown', markdown: 'The explanation is complete.' });
    return {
      kind: 'lesson',
      id: `pairwise-${index}`,
      title: `Pairwise ${index}: ${row.sceneType} / ${row.syntax}`,
      description: JSON.stringify(row),
      type: 'core',
      isCompleted: true,
      content: sources
        .filter(source => source.type === 'markdown')
        .map(source => source.markdown)
        .join('\n\n'),
      contentBlocks: sources,
      generatedVisuals: visuals,
      imageRefs: [],
    };
  });
  const project = syntheticCourse();
  return {
    ...project,
    id: 'playback-pairwise',
    title: 'Playback pairwise combinations',
    createdAt: DATE,
    updatedAt: DATE,
    lastOpenedAt: DATE,
    activeSectionId: lessons[0].id,
    learningPlan: {
      title: 'Playback pairwise combinations',
      summary: 'Deterministic synthetic coverage.',
      applicationExercisePlanningStatus: 'not-run' as const,
      modules: [{ id: 'pairwise', title: 'Playback combinations', children: lessons }],
    },
    extensions: { playbackAtlasCoverage: coverage },
  };
}
