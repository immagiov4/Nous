# Qwen3-TTS OpenAI-Compatible FastAPI Server

This directory contains the TTS server based on `groxaxo/Qwen3-TTS-Openai-Fastapi`.

## Setup

### 1. Clone the original repository

```bash
git clone https://github.com/groxaxo/Qwen3-TTS-Openai-Fastapi .
```

### 2. Install dependencies

```bash
pip install -e ".[api]"
```

### 3. Download the model

```bash
python download_model.py
```

This will download the Qwen3-TTS-12Hz-1.7B-VoiceDesign model (~3GB).

## Running

The server is automatically started by the Node.js backend. You can also run it manually:

```bash
python -m api.main
```

## Environment Variables

- `TTS_MODEL_NAME`: Model ID (default: `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`)
- `TTS_DEVICE`: Device to use (`auto`, `cuda`, `mps`, `cpu`)
- `HF_HOME`: HuggingFace cache directory

## API Endpoints

The server provides OpenAI-compatible endpoints:

- `POST /v1/audio/speech` - Generate speech from text
- `GET /v1/models` - List available models
- `GET /health` - Health check

## Voice Design

Qwen3-TTS VoiceDesign allows creating custom voices through text prompts:

```json
{
  "model": "qwen3-tts",
  "input": "Ciao, come stai?",
  "voice": "Un uomo italiano di 40 anni, voce calda e professionale",
  "response_format": "wav"
}
```
