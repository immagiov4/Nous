export const FIXED_AUDIO_SECONDS = 10;

/** Fixed local mono PCM WAV, long enough to exercise each transport command. */
export function fixedAudio() {
  const sampleRate = 48_000;
  const samples = sampleRate * FIXED_AUDIO_SECONDS;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index++)
    view.setInt16(44 + index * 2, 8192 * Math.sin((2 * Math.PI * 440 * index) / sampleRate), true);
  return bytes;
}
