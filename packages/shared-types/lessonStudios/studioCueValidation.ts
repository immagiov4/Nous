import { cueTimes } from '../lessonSceneAnimation';

export function validateStudioCues(
  scene: { narration: string; studioCues: { anchor: string }[] },
  {
    beatCount,
    narration,
    checkSpec,
  }: {
    beatCount: number;
    narration?: string;
    checkSpec: () => void;
  }
): string[] {
  const { studioCues, narration: storedNarration } = scene;
  if (beatCount !== studioCues.length) return ['Each studio beat needs one narration cue.'];
  if (new Set(studioCues.map(cue => cue.anchor)).size !== studioCues.length)
    return ['Studio narration anchors must be unique and ordered.'];
  try {
    checkSpec();
    if (studioCues.length) {
      cueTimes(storedNarration, studioCues);
      if (narration !== undefined && narration !== storedNarration) cueTimes(narration, studioCues);
    }
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
