# Qwen3-TTS Integration Setup Guide

This guide explains how to set up the local TTS (Text-to-Speech) system using Qwen3-TTS.

## Prerequisites

- **Python 3.10+** with pip
- **Node.js 18+** with npm
- **4GB+ VRAM** (for GPU acceleration) or **8GB+ RAM** (for CPU)

## Quick Start

### 1. Install Backend Dependencies

```bash
cd backend
npm install
cd ..
```

### 2. Clone and Setup TTS Server

```bash
# Clone the Qwen3-TTS FastAPI server
git clone https://github.com/groxaxo/Qwen3-TTS-Openai-Fastapi tts-server

# Install Python dependencies
cd tts-server
pip install -e ".[api]"
cd ..
```

### 3. Download the Model (~3GB)

```bash
npm run setup:tts
```

This will download the `Qwen3-TTS-12Hz-1.7B-VoiceDesign` model.

### 4. Start Everything

```bash
npm run dev
```

This will start:
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3001
- **TTS Server**: http://localhost:8000

## Architecture

```
npm run dev
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│              scripts/start-all.js                            │
│  1. Kill ports 8000, 3001, 5173                             │
│  2. Spawn: npm run dev:backend                               │
│  3. Spawn: npm run dev:frontend                              │
└─────────────────────────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌───────────────────┐   ┌───────────────────┐
│  Backend Node.js  │   │  Frontend Vite    │
│  localhost:3001   │   │  localhost:5173   │
└─────────┬─────────┘   └───────────────────┘
          │
          ▼ spawn
┌─────────────────────────────────────────────────────────────┐
│         Process Manager (backend/src/services/)              │
│  python -m api.main                                          │
│  env: TTS_MODEL_NAME, TTS_DEVICE, HF_HOME                    │
└─────────┬───────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│     Python FastAPI (groxaxo/Qwen3-TTS-Openai-Fastapi)        │
│     localhost:8000/v1/audio/speech                           │
│     Model: Qwen3-TTS-12Hz-1.7B-VoiceDesign                   │
└─────────────────────────────────────────────────────────────┘
```

## Voice Profiles

Two Italian voices are pre-configured:

| Voice | Description |
|-------|-------------|
| **Marco** | Male, 40 years, warm and professional |
| **Giulia** | Female, 30 years, clear and friendly |

## Configuration

Edit `server.config.json` to customize:

```json
{
  "pythonExecutable": "python",
  "ttsServerPort": 8000,
  "device": "auto",  // "cuda", "mps", "cpu", or "auto"
  "startupTimeoutMs": 120000
}
```

## Hardware Requirements

| Device | Requirement | Latency |
|--------|-------------|---------|
| CUDA GPU | 4GB VRAM | ~200-500ms |
| Apple Silicon | 4GB unified | ~300-800ms |
| CPU only | 8GB RAM | ~5-15s |

## Troubleshooting

### TTS Server Won't Start

1. Check Python version: `python --version` (needs 3.10+)
2. Verify dependencies: `pip list | grep transformers`
3. Check logs in terminal for errors

### Model Download Fails

1. Ensure you have enough disk space (~4GB)
2. Check internet connection
3. Try manual download:
   ```bash
   cd tts-server
   python download_model.py
   ```

### Audio Quality Issues

1. Ensure you're using the VoiceDesign model (not Base)
2. Check the voice design prompt in `backend/src/config/voice-profiles.json`
3. Adjust temperature in voice profile settings

## API Endpoints

### Backend (Node.js)

- `POST /api/tts` - Generate speech
- `GET /api/voices` - List available voices
- `GET /api/status` - Check TTS server status

### TTS Server (Python)

- `POST /v1/audio/speech` - OpenAI-compatible TTS endpoint
- `GET /v1/models` - List models
- `GET /health` - Health check

## Stopping Services

```bash
npm run stop
```

This will kill all processes on ports 8000, 3001, and 5173.
