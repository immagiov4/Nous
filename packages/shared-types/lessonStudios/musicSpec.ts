import * as z from 'zod';
import { geometryBeatFields } from './geometryStudioSpec';
import { copy } from './music.copy.it';

const steps = z.array(z.number().int().min(1).max(16));
export const MusicSpecSchema = z.object({
  title: z.string().min(1),
  key: z.string().regex(/^[A-G][#b]?m?$/u),
  degrees: z.array(z.number().int().min(1).max(7)).min(1).max(8).optional(),
  views: z.array(z.enum(['staff', 'keyboard', 'intervals', 'drums'])).min(1),
  drums: z.object({ bpm: z.number().positive(), kick: steps, snare: steps, hat: steps }).optional(),
  beats: z
    .array(
      z.object({
        ...geometryBeatFields,
        active: z.array(z.number().int().nonnegative()).optional(),
        focus: z.enum(['signature', 'staff', 'keyboard', 'intervals', 'drums']).optional(),
        cycle: z.boolean().optional(),
      })
    )
    .min(1),
});
export type MusicSpec = z.infer<typeof MusicSpecSchema>;
export const musicModelGuide =
  'music {title,key:"Bm",views:[staff,keyboard,intervals,drums],degrees?:[1,6,3,7],drums?:{bpm,kick:[1,9],snare:[5,13],hat:[1,3,5,…]},beats:[{at,callout?,active?:[0,1],focus?:signature|staff|keyboard|intervals|drums,cycle?}]}. Key is major or natural minor. Omit degrees for scale; otherwise engine stacks thirds. active indexes notes or chords from zero. Drum steps 1–16; cycle advances one chord each 4/4 bar. Example beat {at:"b1",focus:"signature"} . 1–8 degrees; intervals view requires a scale (omit degrees), and drums view requires drums.';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const SIGNATURES = new Set(
  'C G D A E B F# C# F Bb Eb Ab Db Gb Cb Am Em Bm F#m C#m G#m D#m A#m Dm Gm Cm Fm Bbm Ebm Abm'.split(
    ' '
  )
);
const mod = (n: number, m: number) => ((n % m) + m) % m;

export function musicPitches(key: string, degrees?: number[]) {
  const letterIndex = LETTERS.indexOf(key[0]);
  const accidentalOffset = Number(key[1] === '#') - Number(key[1] === 'b');
  const tonic = 60 + SEMITONES[letterIndex] + accidentalOffset;
  const intervals = key.endsWith('m') ? MINOR : MAJOR;
  const note = (degree: number, transpose = 0) => {
    const scaleIndex = degree - 1;
    const letter = mod(letterIndex + scaleIndex, 7);
    const octave = 4 + Math.floor((letterIndex + scaleIndex) / 7) + transpose;
    const midi =
      tonic + intervals[mod(scaleIndex, 7)] + 12 * (Math.floor(scaleIndex / 7) + transpose);
    const offset = midi - ((octave + 1) * 12 + SEMITONES[letter]);
    const accidental = offset > 0 ? '#'.repeat(offset) : 'b'.repeat(-offset);
    return {
      midi,
      key: `${LETTERS[letter].toLowerCase()}${accidental}/${octave}`,
      name: copy.notes[letter] + accidental.replaceAll('#', '♯').replaceAll('b', '♭'),
      octave,
    };
  };
  return degrees
    ? degrees.map(degree => {
        const shift = note(degree).octave - 4;
        return [degree, degree + 2, degree + 4].map(i => note(i, -shift));
      })
    : Array.from({ length: 8 }, (_, index) => [note(index + 1)]);
}

export const hitTracks = ['kick', 'snare', 'hat'] as const;
export const STEPS = 16;
export const SIXTEENTHS_PER_BEAT = 4;

/** Transport adapter seam for Tone.js. A future audio host can schedule these indices from
 * its own transport, leaving seek and preview silent and free of timers. */
export function transportStep(seconds: number, bpm: number) {
  return Math.max(0, Math.floor((seconds * bpm * SIXTEENTHS_PER_BEAT) / 60));
}

export function checkMusicSpec(spec: MusicSpec) {
  if (!SIGNATURES.has(spec.key)) throw new Error('Unsupported key signature');
  if (spec.views.includes('intervals') && spec.degrees)
    throw new Error('Intervals require a scale');
  if (spec.views.includes('drums') !== Boolean(spec.drums))
    throw new Error('Drum view requires a pattern');
  for (const beat of spec.beats) {
    if (beat.active?.some(index => index >= (spec.degrees?.length ?? 8)))
      throw new Error('Unknown music index');
    if (beat.cycle && (!spec.degrees || !spec.drums))
      throw new Error('Cycle requires chords and BPM');
    const view = beat.focus === 'signature' ? 'staff' : beat.focus;
    if (view && !spec.views.includes(view)) throw new Error('Focus requires a displayed view');
  }
}
