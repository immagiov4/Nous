update public.model_config
set
  tts_model = 'google/gemini-3.8-flash-lite-tts',
  updated_at = timezone('utc', now())
where id = 'global'
  and tts_model = 'google/gemini-3.8-flash-tts';
