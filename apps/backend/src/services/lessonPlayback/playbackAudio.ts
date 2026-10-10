import { Mp3Encoder } from '@breezystack/lamejs';
import type { PlaybackAudio } from '@shared/lessonPlayback';

import { getResolvedGlobalModelConfig } from '../../config/modelConfig.js';
import { ttsClient } from '../ttsClient.js';
import { mp3DurationSeconds } from './playbackMp3.js';

export type PreparedPlaybackAudio = Omit<PlaybackAudio, 'asset'> & {
  readonly bytes: Uint8Array;
  readonly mediaType: 'audio/mpeg';
};

const MP3_BITRATE_KBPS = 64;
const MP3_MONO_CHANNELS = 1;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_WAV_HEADER_BYTES = 44;

/** Reads the canonical PCM16 WAV emitted by ttsClient, downmixing its channels to mono. */
const encodeSpeechWav = (audioBuffer: ArrayBuffer) => {
  const wav = Buffer.from(audioBuffer);
  if (
    wav.length <= PCM_WAV_HEADER_BYTES ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    wav.readUInt32LE(16) !== 16 ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(34) !== 16 ||
    wav.toString('ascii', 36, 40) !== 'data' ||
    wav.readUInt32LE(40) !== wav.length - PCM_WAV_HEADER_BYTES
  ) {
    throw new Error('Expected the TTS client PCM16 WAV format.');
  }
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const blockAlign = channels * PCM_BYTES_PER_SAMPLE;
  const pcmBytes = wav.length - PCM_WAV_HEADER_BYTES;
  if (!channels || !sampleRate || pcmBytes % blockAlign !== 0) {
    throw new Error('Invalid TTS PCM sample layout.');
  }
  const samples = new Int16Array(pcmBytes / blockAlign);
  for (let frame = 0; frame < samples.length; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += wav.readInt16LE(
        PCM_WAV_HEADER_BYTES + frame * blockAlign + channel * PCM_BYTES_PER_SAMPLE
      );
    }
    samples[frame] = Math.round(sum / channels);
  }
  const encoder = new Mp3Encoder(MP3_MONO_CHANNELS, sampleRate, MP3_BITRATE_KBPS);
  return {
    // The encoder returns Int8Array chunks; Buffer.concat accepts only Uint8Array views.
    bytes: Buffer.concat(
      [encoder.encodeBuffer(samples), encoder.flush()].map(chunk =>
        Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      )
    ),
    durationSeconds: samples.length / sampleRate,
  };
};

/** Prepares one utterance with the configured TTS model; MP3 responses retain their bytes. */
export const preparePlaybackAudio = async ({
  text,
  voice,
  signal,
}: {
  readonly text: string;
  readonly voice: string;
  readonly signal: AbortSignal;
}): Promise<PreparedPlaybackAudio> => {
  signal.throwIfAborted();
  const { ttsModel: model } = await getResolvedGlobalModelConfig();
  signal.throwIfAborted();
  const audio = await ttsClient.generateSpeech({ model, signal, text, voice });
  signal.throwIfAborted();
  const mediaType = audio.contentType.split(';', 1)[0].trim().toLowerCase();
  let prepared: { bytes: Uint8Array; durationSeconds: number };
  if (mediaType === 'audio/wav') {
    prepared = encodeSpeechWav(audio.audioBuffer);
  } else if (mediaType === 'audio/mpeg' || mediaType === 'audio/mp3') {
    const bytes = new Uint8Array(audio.audioBuffer);
    prepared = { bytes, durationSeconds: mp3DurationSeconds(bytes) };
  } else {
    throw new Error('Unsupported TTS audio format.');
  }
  return {
    ...prepared,
    mediaType: 'audio/mpeg',
    model: audio.model,
    voice: audio.voice,
  };
};
