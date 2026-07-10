update public.model_config
set
  tts_model = 'x-ai/grok-voice-tts-1.0',
  tts_voice = 'Ara',
  updated_at = timezone('utc', now())
where tts_model in (
  'openai/gpt-4o-mini-tts',
  'openai/gpt-4o-mini-tts-2025-12-15',
  'mistralai/voxtral-mini-tts-2603'
);
