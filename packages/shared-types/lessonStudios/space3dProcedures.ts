import { phases, type Beat, type Spec } from "./space3dSpec";

/** Fill in discrete procedure stages specified by earlier and later states. */
export function proceduralBeats(spec: Spec, beatTimesMs: number[]) {
  const beats: Beat[] = [];
  const pins: { index: number; time: number }[] = [];
  const pipeline = spec.layers.length === 1 && spec.layers[0] === "pipeline";
  let phase = -1, depth = 0, poured = 0;
  let sliceView: Beat["sliceView"];
  let partitionShown = false;
  for (const [i, beat] of spec.beats.entries()) {
    if (pipeline) {
      const next = beat.phase ? phases.indexOf(beat.phase) : Math.max(0, phase);
      for (let step = phase + 1; step < next; step++) beats.push({ phase: phases[step] });
      phase = next;
    }
    if (beat.depth !== undefined) {
      for (let step = depth + 1; step < beat.depth; step++) beats.push({ depth: step });
      depth = beat.depth;
    }
    if (beat.sliceView === "conclusion" && !partitionShown) {
      beats.push({ sliceView: "reassemble" });
      partitionShown = true;
    }
    partitionShown ||= ["dissect", "superpose", "reassemble"].includes(beat.sliceView ?? "");
    sliceView = beat.sliceView ?? sliceView;
    if (beat.poured !== undefined) {
      if (sliceView === "pour") for (let step = poured + 1; step < beat.poured; step++) {
        beats.push({ sliceView, poured: step });
      }
      poured = beat.poured;
    }
    pins.push({ index: beats.length, time: beatTimesMs[i] / 1000 });
    beats.push(beat);
  }
  if (pipeline) for (let step = phase + 1; step < phases.length; step++) beats.push({ phase: phases[step] });

  return { beats, pins };
}
