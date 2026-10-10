import { beforeEach, expect, test, vi } from 'vitest';

const { generateSpeech, getConfig } = vi.hoisted(() => ({
  generateSpeech: vi.fn(),
  getConfig: vi.fn(),
}));
vi.mock('../../../src/services/ttsClient.js', () => ({ ttsClient: { generateSpeech } }));
vi.mock('../../../src/config/modelConfig.js', () => ({ getResolvedGlobalModelConfig: getConfig }));

import { preparePlaybackAudio } from '../../../src/services/lessonPlayback/playbackAudio.js';
import { mp3DurationSeconds } from '../../../src/services/lessonPlayback/playbackMp3.js';

beforeEach(() => {
  vi.resetAllMocks();
  getConfig.mockResolvedValue({ ttsModel: 'google/gemini-3.8-flash-tts' });
});

const pcmWav = (channels = 1) => {
  const sampleRate = 24000;
  const sampleCount = sampleRate;
  const wav = Buffer.alloc(44 + sampleCount * channels * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let index = 0; index < sampleCount * channels; index += 1) {
    wav.writeInt16LE(
      Math.round(Math.sin((Math.floor(index / channels) * 2 * Math.PI * 440) / sampleRate) * 12000),
      44 + index * 2
    );
  }
  return Uint8Array.from(wav).buffer;
};

const request = () => ({ text: 'Una frase.', voice: 'Kore', signal: new AbortController().signal });

test.each([
  1, 2,
])('encodes %i-channel PCM as valid mono 64 kb/s MP3 with PCM duration', async channels => {
  generateSpeech.mockResolvedValue({
    audioBuffer: pcmWav(channels),
    contentType: 'audio/wav',
    model: 'google/gemini-3.8-flash-tts',
    voice: 'Kore',
  });
  const input = request();
  const result = await preparePlaybackAudio(input);
  expect(generateSpeech).toHaveBeenCalledWith({ ...input, model: 'google/gemini-3.8-flash-tts' });
  expect(result).toMatchObject({ mediaType: 'audio/mpeg', durationSeconds: 1, voice: 'Kore' });
  // Independently inspect every MPEG-2 Layer III frame: 24 kHz, 64 kb/s, mono, 576 samples.
  const bytes = Buffer.from(result.bytes);
  let offset = 0;
  let frames = 0;
  while (offset < bytes.length) {
    const header = bytes.readUInt32BE(offset);
    expect(header >>> 21).toBe(0x7ff);
    expect((header >>> 19) & 3).toBe(2);
    expect((header >>> 17) & 3).toBe(1);
    expect((header >>> 12) & 15).toBe(8);
    expect((header >>> 10) & 3).toBe(1);
    expect((header >>> 6) & 3).toBe(3);
    offset += 192 + ((header >>> 9) & 1);
    frames += 1;
  }
  expect(offset).toBe(bytes.length);
  expect((frames * 576) / 24000).toBeGreaterThanOrEqual(1);
  // Encoder delay and padding occupy fewer than three extra frames for this fixture.
  expect((frames * 576) / 24000).toBeLessThan(1 + (3 * 576) / 24000);
});

// Three complete MPEG-1 Layer III silent frame payloads: 128 kb/s, 44.1 kHz.
const mp3Frames = () => {
  const frames = Buffer.alloc(417 * 3);
  for (let offset = 0; offset < frames.length; offset += 417)
    frames.writeUInt32BE(0xfffb90c0, offset);
  return frames;
};

test('passes non-Gemini MP3 through and measures frames rather than estimating from bytes', async () => {
  const bytes = mp3Frames();
  getConfig.mockResolvedValue({ ttsModel: 'x-ai/grok-voice-tts-1.0' });
  generateSpeech.mockResolvedValue({
    audioBuffer: Uint8Array.from(bytes).buffer,
    contentType: 'audio/mpeg',
    model: 'x-ai/grok-voice-tts-1.0',
    voice: 'Ara',
  });
  const result = await preparePlaybackAudio(request());
  expect(Buffer.from(result.bytes)).toEqual(bytes);
  expect(result.durationSeconds).toBeCloseTo((3 * 1152) / 44100, 10);
  expect(result).toMatchObject({ model: 'x-ai/grok-voice-tts-1.0', voice: 'Ara' });
});

test('skips ID3 metadata and counts variable bitrate frames', () => {
  const tag = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0]);
  const highBitrateFrame = Buffer.alloc(626);
  highBitrateFrame.writeUInt32BE(0xfffbb0c0);
  const trailingTag = Buffer.alloc(128);
  trailingTag.write('TAG');
  expect(
    mp3DurationSeconds(Buffer.concat([tag, mp3Frames(), highBitrateFrame, trailingTag]))
  ).toBeCloseTo((4 * 1152) / 44100, 10);
});

test.each([
  Buffer.alloc(0),
  Buffer.from('not mp3'),
  mp3Frames().subarray(0, 100),
])('rejects missing or truncated MP3 frames', bytes => {
  expect(() => mp3DurationSeconds(bytes)).toThrow();
});

test('propagates cancellation before requesting speech', async () => {
  await expect(
    preparePlaybackAudio({ ...request(), signal: AbortSignal.abort() })
  ).rejects.toThrow();
  expect(generateSpeech).not.toHaveBeenCalled();
});

test('discards speech returned after cancellation', async () => {
  const controller = new AbortController();
  generateSpeech.mockImplementation(async () => {
    controller.abort();
    return { audioBuffer: pcmWav(), contentType: 'audio/wav' };
  });
  await expect(preparePlaybackAudio({ ...request(), signal: controller.signal })).rejects.toThrow();
});

test.each([
  'audio/ogg',
  'audio/wav',
])('rejects unsupported or malformed %s audio', async contentType => {
  generateSpeech.mockResolvedValue({ audioBuffer: new ArrayBuffer(0), contentType });
  await expect(preparePlaybackAudio(request())).rejects.toThrow();
});
