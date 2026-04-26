# Optional Local TTS Server

Nous Reader's default speech playback uses the backend `/api/tts` route, and that route generates speech through OpenRouter. The `tts-server/` folder is a separate FastAPI Qwen3-TTS service that you can run on its own if you want a local TTS runtime.

## When To Use It

- You want to run the standalone Qwen3-TTS API at `http://localhost:8880`
- You want to inspect or develop the Python server in `tts-server/`
- You want to compare the standalone local server against the app's default OpenRouter-backed TTS path

## Requirements

- Python 3.9 or newer
- The Python dependencies listed in `tts-server/pyproject.toml`

## Start The Server

From the repo root:

```bash
npm run dev:tts
```

Or from inside `tts-server/`:

```bash
python -m api.main
```

The standalone server defaults to port `8880`.

## Notes

- This service is separate from the main `npm run dev` flow.
- The app does not need it for normal reading, planning, or library use.
- For the full standalone server documentation, see `tts-server/README.md` and `tts-server/SETUP.md`.
