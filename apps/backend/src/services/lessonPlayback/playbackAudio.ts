import type { PlaybackAudio } from '@shared/lessonPlayback';

import { getResolvedGlobalModelConfig } from '../../config/modelConfig.js';
import { failPermanently } from '../../workflows/retryPolicy.js';
import { encodeSpeechAudio } from '../speechAudio.js';
import { synthesizeSpeech } from '../speechPreparation.js';
import { MAX_TTS_TEXT_CHARS } from '../ttsClient.js';

export type PreparedPlaybackAudio = Omit<PlaybackAudio, 'asset'> & {
  readonly bytes: Uint8Array;
  readonly mediaType: 'audio/mpeg';
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
  const prepared = await encodeSpeechAudio(audio);
  signal.throwIfAborted();
  return {
    ...prepared,
    mediaType: 'audio/mpeg',
    model: audio.model,
    voice: audio.voice,
  };
};
