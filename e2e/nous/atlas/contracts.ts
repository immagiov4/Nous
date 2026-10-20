import type { LessonPlaybackBlock } from '../../../packages/shared-types/lessonPlayback';
import type { AtlasFinding, Position } from './checks';
import type { AtlasLesson } from './input';

export interface AtlasSample {
  lesson: AtlasLesson;
  block: LessonPlaybackBlock;
  position: Position;
  visualIndex: number | null;
}
export interface AtlasRendered {
  duration: number;
  time: number;
  speech: string;
  captions: string[];
  expectedVisual: boolean;
  findings: AtlasFinding[];
}
declare global {
  interface Window {
    playbackAtlas: {
      prepare: (lesson: AtlasLesson) => LessonPlaybackBlock[];
      render: (sample: AtlasSample) => Promise<AtlasRendered>;
      ready: () => Promise<void>;
    };
  }
}
