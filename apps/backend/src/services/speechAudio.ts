import { Mp3Encoder } from '@breezystack/lamejs';
import { MPEGDecoder } from 'mpg123-decoder';
import type { GeneratedSpeechAudio } from '../types/index.js';
import { mp3DurationSeconds } from './lessonPlayback/playbackMp3.js';

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

/** Normalize provider WAV or MP3 into the shared mono speech format. */
export const encodeSpeechAudio = async (
  audio: Pick<GeneratedSpeechAudio, 'contentType' | 'audioBuffer'>
) => {
  const mediaType = audio.contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'audio/wav') return encodeSpeechWav(audio.audioBuffer);
  if (mediaType === 'audio/mpeg' || mediaType === 'audio/mp3')
    return reencodeSpeechMp3(audio.audioBuffer);
  throw new Error('Unsupported TTS audio format.');
};
