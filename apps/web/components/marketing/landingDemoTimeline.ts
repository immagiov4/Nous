export type DemoStage = 'plan' | 'generation' | 'lesson' | 'library';

export const DEMO_FPS = 30;
export const DEMO_WIDTH = 1200;
export const DEMO_HEIGHT = 800;
export const DEMO_ASPECT_RATIO = `${DEMO_WIDTH} / ${DEMO_HEIGHT}`;
export const DEFAULT_DEMO_DURATION_IN_FRAMES = 240;
export const LESSON_DEMO_DURATION_IN_FRAMES = 1650;
export const LIBRARY_DEMO_DURATION_IN_FRAMES = 660;
export const PLAN_DEMO_DURATION_IN_FRAMES = 750;

export const LIBRARY_FIRST_SEND_FRAME = 135;
export const LIBRARY_SECOND_SEND_FRAME = 410;
export const LIBRARY_ARTIFACT_FRAME = 500;
export const LIBRARY_ARTIFACT_PREVIEW_FRAME = 610;

export const LESSON_SELECTION_CLICK_FRAME = 48;
export const LESSON_QUESTION_START_FRAME = 78;
export const LESSON_QUESTION_END_FRAME = 132;
export const LESSON_SEND_CLICK_FRAME = 158;
export const LESSON_ANSWER_START_FRAME = 174;
export const LESSON_ANSWER_END_FRAME = 226;
export const LESSON_NOTE_DRAFT_START_FRAME = 250;
export const LESSON_NOTE_DRAFT_END_FRAME = 318;
export const LESSON_NOTE_SEND_FRAME = 330;
export const LESSON_NOTE_REPLY_START_FRAME = 345;
export const LESSON_NOTE_REPLY_END_FRAME = 395;
export const LESSON_NOTE_TOOL_FRAME = 405;
export const LESSON_NOTE_APPROVE_FRAME = 450;
export const LESSON_NOTE_SAVED_FRAME = 462;
export const LESSON_FIRST_CHAT_CLOSE_FRAME = 510;
export const LESSON_FIRST_CHAT_DISMISS_FRAME = 522;
export const LESSON_FIRST_ANNOTATION_CLICK_FRAME = 550;
export const LESSON_GRAPH_DRAFT_START_FRAME = 585;
export const LESSON_GRAPH_DRAFT_END_FRAME = 680;
export const LESSON_GRAPH_SEND_FRAME = 700;
export const LESSON_SECOND_CHAT_OPEN_FRAME = 708;
export const LESSON_GRAPH_REPLY_START_FRAME = 730;
export const LESSON_GRAPH_REPLY_END_FRAME = 790;
export const LESSON_ARTIFACT_LOADING_FRAME = 800;
export const LESSON_ARTIFACT_READY_FRAME = 870;
export const LESSON_ARTIFACT_OPEN_FRAME = 920;
export const LESSON_ARTIFACT_PREVIEW_FRAME = 928;
export const LESSON_ARTIFACT_SAVE_FRAME = 1010;
export const LESSON_ARTIFACT_CLOSE_FRAME = 1045;
export const LESSON_ARTIFACT_DISMISS_FRAME = 1053;
export const LESSON_ATTACH_DRAFT_START_FRAME = 1070;
export const LESSON_ATTACH_DRAFT_END_FRAME = 1140;
export const LESSON_ATTACH_SEND_FRAME = 1160;
export const LESSON_ATTACH_REPLY_START_FRAME = 1175;
export const LESSON_ATTACH_REPLY_END_FRAME = 1195;
export const LESSON_UPDATE_NOTE_TOOL_FRAME = 1200;
export const LESSON_UPDATE_NOTE_APPROVE_FRAME = 1260;
export const LESSON_NOTE_UPDATED_FRAME = 1270;
export const LESSON_SECOND_CHAT_CLOSE_FRAME = 1320;
export const LESSON_SECOND_CHAT_DISMISS_FRAME = 1332;
export const LESSON_FINAL_ANNOTATION_CLICK_FRAME = 1350;
export const LESSON_FINAL_NOTE_OPEN_FRAME = 1360;
export const LESSON_FINAL_NOTE_SCROLL_START_FRAME = 1390;
export const LESSON_FINAL_NOTE_SCROLL_END_FRAME = 1460;
export const LESSON_FINAL_ARTIFACT_OPEN_FRAME = 1490;
export const LESSON_FINAL_ARTIFACT_PREVIEW_FRAME = 1498;

export const DEMO_STAGE_CONFIG = [
  { stage: 'plan', durationInFrames: PLAN_DEMO_DURATION_IN_FRAMES },
  { stage: 'generation', durationInFrames: DEFAULT_DEMO_DURATION_IN_FRAMES },
  { stage: 'lesson', durationInFrames: LESSON_DEMO_DURATION_IN_FRAMES },
  { stage: 'library', durationInFrames: LIBRARY_DEMO_DURATION_IN_FRAMES },
] as const satisfies ReadonlyArray<{ stage: DemoStage; durationInFrames: number }>;

export const DEMO_JOURNEY_DURATION_IN_FRAMES = DEMO_STAGE_CONFIG.reduce(
  (total, { durationInFrames }) => total + durationInFrames,
  0
);

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
