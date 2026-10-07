update public.model_config
set
  tts_model = 'google/gemini-3.8-flash-tts',
  tts_voice = 'Zephyr',
  updated_at = timezone('utc', now())
where id = 'global'
  and tts_model = 'x-ai/grok-voice-tts-1.0';
