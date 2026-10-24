import { MPEGDecoder } from 'mpg123-decoder';

// Aeneas' word-level analysis uses 20 ms windows at 5 ms intervals.
const WINDOW_SECONDS = 0.02;
const SHIFT_SECONDS = 0.005;
const FLOAT32_MIN_NORMAL = 2 ** -126;

/** Otsu's two-class split on observed log energy; no fixed silence/amplitude cutoff. */
function energyThreshold(energy: readonly number[]) {
  const sorted = [...energy].sort((a, b) => a - b);
  const sum = sorted.reduce((sum, value) => sum + value, 0);
  let prefix = 0;
  let best = -1;
  let threshold = sorted[0];
  for (let count = 1; count < sorted.length; count++) {
    prefix += sorted[count - 1];
    const rest = sorted.length - count;
    const separation = prefix / count - (sum - prefix) / rest;
    const score = count * rest * separation ** 2;
    if (score > best) {
      best = score;
      threshold = (sorted[count - 1] + sorted[count]) / 2;
    }
  }
  return threshold;
}

/** Remove only leading low-energy frames inside each aligned word, preserving word order. */
export function trimWordSilence(
  samples: Float32Array,
  sampleRate: number,
  fragments: readonly { begin: number; end: number }[]
): number[] {
  const shift = Math.round(sampleRate * SHIFT_SECONDS);
  const window = Math.round(sampleRate * WINDOW_SECONDS);
  const energy: number[] = [];
  for (let start = 0; start + window < samples.length; start += shift) {
    let power = 0;
    for (let i = start; i < start + window; i++) power += samples[i] ** 2;
    energy.push(Math.log(Math.max(power / window, FLOAT32_MIN_NORMAL)));
  }
  const threshold = energyThreshold(energy);
  const frameSeconds = shift / sampleRate;
  return fragments.map(({ begin, end }) => {
    for (
      let frame = Math.ceil(begin / frameSeconds);
      frame < Math.min(energy.length, Math.ceil(end / frameSeconds));
      frame++
    ) {
      if (energy[frame] > threshold) return Math.max(begin, frame * frameSeconds);
    }
    return begin;
  });
}

/** Decode the original saved MP3 locally; decoder lifetime is bounded by this alignment. */
export async function trimRecordingSilence(
  bytes: Uint8Array,
  fragments: readonly { begin: number; end: number }[]
) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, sampleRate, samplesDecoded, errors } = decoder.decode(bytes);
    if (errors.length || !samplesDecoded || !channelData.length || !sampleRate)
      throw new Error('Invalid recording alignment audio.');
    const mono = new Float32Array(samplesDecoded);
    for (const channel of channelData) {
      for (let i = 0; i < samplesDecoded; i++) mono[i] += channel[i] / channelData.length;
    }
    return trimWordSilence(mono, sampleRate, fragments);
  } finally {
    decoder.free();
  }
}
