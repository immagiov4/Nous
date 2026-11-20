import { cueTimes } from '../lessonSceneAnimation';

export function validateStudioCues(
  scene: { narration: string; studioCues: { anchor: string }[] },
  {
    beatCount,
    narration,
    checkSpec,
    distinctTimes = false,
  }: {
    beatCount: number;
    narration?: string;
    checkSpec: () => void;
    distinctTimes?: boolean;
  }
): string[] {
  const { studioCues, narration: storedNarration } = scene;
  if (beatCount !== studioCues.length) return ['Each studio beat needs one narration cue.'];
  if (new Set(studioCues.map(cue => cue.anchor)).size !== studioCues.length)
    return ['Studio narration anchors must be unique and ordered.'];
  try {
    checkSpec();
    if (studioCues.length) {
      checkCueTimes(storedNarration, studioCues, distinctTimes);
      if (narration !== undefined && narration !== storedNarration)
        checkCueTimes(narration, studioCues, distinctTimes);
    }
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function checkCueTimes(narration: string, cues: { anchor: string }[], distinctTimes: boolean) {
  const times = cueTimes(narration, cues);
  if (distinctTimes && times.some((time, index) => index > 0 && time <= times[index - 1]))
    throw new Error('Each geometry beat must start at a distinct narration time.');
}
