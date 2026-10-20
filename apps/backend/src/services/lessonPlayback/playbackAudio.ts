import { Mp3Encoder } from '@breezystack/lamejs';
import type { PlaybackAudio } from '@shared/lessonPlayback';
import { MPEGDecoder } from 'mpg123-decoder';

import { getResolvedGlobalModelConfig } from '../../config/modelConfig.js';
import { failPermanently } from '../../workflows/retryPolicy.js';
import { synthesizeSpeech } from '../speechPreparation.js';
import { MAX_TTS_TEXT_CHARS } from '../ttsClient.js';
import { mp3DurationSeconds } from './playbackMp3.js';

export type PreparedPlaybackAudio = Omit<PlaybackAudio, 'asset'> & {
  readonly bytes: Uint8Array;
  readonly mediaType: 'audio/mpeg';
};

const MP3_BITRATE_KBPS = 64;
const MP3_MONO_CHANNELS = 1;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_WAV_HEADER_BYTES = 44;
const PCM16_MAGNITUDE = 2 ** (PCM_BYTES_PER_SAMPLE * 8 - 1);

const encodeMonoSamples = (samples: Int16Array, sampleRate: number): Buffer => {
  const encoder = new Mp3Encoder(MP3_MONO_CHANNELS, sampleRate, MP3_BITRATE_KBPS);
  // The encoder returns Int8Array chunks; Buffer.concat accepts only Uint8Array views.
  return Buffer.concat(
    [encoder.encodeBuffer(samples), encoder.flush()].map(chunk =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    )
  );
};

const reencodeSpeechMp3 = async (audioBuffer: ArrayBuffer) => {
  const input = new Uint8Array(audioBuffer);
  mp3DurationSeconds(input);
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, samplesDecoded, sampleRate, errors } = decoder.decode(input);
    if (errors.length || !samplesDecoded || !sampleRate || !channelData.length) {
      throw new Error('Invalid TTS MP3 audio.');
    }
    const samples = new Int16Array(samplesDecoded);
    for (let frame = 0; frame < samples.length; frame += 1) {
      let sum = 0;
      for (const channel of channelData) sum += channel[frame];
      const mono = Math.max(-1, Math.min(1, sum / channelData.length));
      samples[frame] = Math.round(mono * (mono < 0 ? PCM16_MAGNITUDE : PCM16_MAGNITUDE - 1));
    }
    const bytes = encodeMonoSamples(samples, sampleRate);
    return { bytes, durationSeconds: mp3DurationSeconds(bytes) };
  } finally {
    decoder.free();
  }
};

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
  return {
    bytes: encodeMonoSamples(samples, sampleRate),
    durationSeconds: samples.length / sampleRate,
  };
};

/** Reject oversized speech before either audio or visual provider work can begin. */
export const validatePlaybackText = (text: string): void => {
  if (text.length > MAX_TTS_TEXT_CHARS) {
    throw failPermanently({
      code: 'lesson_playback_text_too_long',
      message: 'Playback text exceeds the speech request limit.',
    });
  }
};

/** Prepares one utterance as mono MP3 using the shared speech encoder settings. */
export const preparePlaybackAudio = async ({
  text,
  voice,
  signal,
  model: requestedModel,
}: {
  readonly model?: string;
  readonly text: string;
  readonly voice: string;
  readonly signal: AbortSignal;
}): Promise<PreparedPlaybackAudio> => {
  signal.throwIfAborted();
  validatePlaybackText(text);
  const model = requestedModel ?? (await getResolvedGlobalModelConfig()).ttsModel;
  signal.throwIfAborted();
  const audio = await synthesizeSpeech({ model, signal, text, voice });
  signal.throwIfAborted();
  const mediaType = audio.contentType.split(';', 1)[0].trim().toLowerCase();
  let prepared: { bytes: Uint8Array; durationSeconds: number };
  if (mediaType === 'audio/wav') {
    prepared = encodeSpeechWav(audio.audioBuffer);
  } else if (mediaType === 'audio/mpeg' || mediaType === 'audio/mp3') {
    prepared = await reencodeSpeechMp3(audio.audioBuffer);
  } else {
    throw new Error('Unsupported TTS audio format.');
  }
  signal.throwIfAborted();
  return {
    ...prepared,
    mediaType: 'audio/mpeg',
    model: audio.model,
    voice: audio.voice,
  };
};
