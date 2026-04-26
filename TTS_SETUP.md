# OpenRouter OpenAI TTS Setup Guide

Nous Reader uses OpenRouter for text-to-speech billing and routes every reader speech request to OpenAI TTS through `POST /api/v1/audio/speech`.

## Requirements

- `OPENROUTER_API_KEY` in `backend/.env.local` or the project root `.env.local`
- Node.js dependencies installed with `npm install`

## Defaults

| Setting | Default |
| --- | --- |
| TTS model | `openai/gpt-4o-mini-tts-2025-12-15` |
| Voice ID | `coral` |
| Output format | `mp3` |

Optional environment overrides:

```powershell
$env:MODEL_TTS="openai/gpt-4o-mini-tts-2025-12-15"
$env:TTS_VOICE="coral"
npm run dev
```

## Supported Voices

The app exposes the OpenAI TTS built-in voices documented by OpenAI:

`alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, `verse`, `marin`, and `cedar`.

Unsupported or stale saved voice IDs are normalized back to `coral`.

## API Flow

```text
Reader UI
  -> backend POST /api/tts
  -> OpenRouter POST /api/v1/audio/speech
  -> OpenAI TTS model
  -> audio/mpeg bytes
```

The backend also exposes:

- `GET /api/tts/models` - the single active OpenAI TTS model
- `GET /api/voices` - the OpenAI voice list configured for the reader
- `GET /api/status` - OpenRouter TTS readiness

## Legacy Local TTS

The old local Qwen/Python `tts-server` folder is kept in the repository as inactive legacy code. It is no longer started by the main TTS flow and is not required for OpenRouter TTS.
