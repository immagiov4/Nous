insert into public.model_config (
  id,
  lesson_model,
  context_model,
  assessment_model,
  tts_model,
  tts_voice
)
values (
  'global',
  'openai/gpt-5.6-luna',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.1-flash-lite',
  'x-ai/grok-voice-tts-1.0',
  'Ara'
)
on conflict (id) do nothing;
