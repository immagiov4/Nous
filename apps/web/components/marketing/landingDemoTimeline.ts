export type DemoStage = 'plan' | 'generation' | 'lesson' | 'library';

export const DEMO_FPS = 30;
export const DEFAULT_DEMO_DURATION_IN_FRAMES = 240;
export const LESSON_DEMO_DURATION_IN_FRAMES = 1650;
export const LIBRARY_DEMO_DURATION_IN_FRAMES = 660;
export const PLAN_DEMO_DURATION_IN_FRAMES = 750;

export const DEMO_STAGE_CONFIG = [
  { stage: 'plan', durationInFrames: PLAN_DEMO_DURATION_IN_FRAMES },
  { stage: 'generation', durationInFrames: DEFAULT_DEMO_DURATION_IN_FRAMES },
  { stage: 'lesson', durationInFrames: LESSON_DEMO_DURATION_IN_FRAMES },
  { stage: 'library', durationInFrames: LIBRARY_DEMO_DURATION_IN_FRAMES },
] as const satisfies ReadonlyArray<{ stage: DemoStage; durationInFrames: number }>;

export interface DemoStageSegment {
  endSeconds: number;
  startSeconds: number;
}

const buildStageSegments = (): Record<DemoStage, DemoStageSegment> => {
  let startSeconds = 0;
  return Object.fromEntries(
    DEMO_STAGE_CONFIG.map(({ durationInFrames, stage }) => {
      const endSeconds = startSeconds + durationInFrames / DEMO_FPS;
      const segment = [stage, { startSeconds, endSeconds }] as const;
      startSeconds = endSeconds;
      return segment;
    })
  ) as Record<DemoStage, DemoStageSegment>;
};

export const DEMO_STAGE_SEGMENTS = buildStageSegments();
