# Lumina TTS Setup (Windows, Mario Profile)

This setup is for:
- fixed cloned voice profile `Mario`
- clone prompt cached once and reused
- 0.6B model for faster inference
- stable attention (`sdpa`) on RTX 2060

## 1) Why FlashAttention2 is not active

On your machine:
- GPU: RTX 2060
- CUDA capability: `7.5` (Turing)

`flash-attn` / `flash_attention_2` is typically for Ampere+ (`sm80+`), so on RTX 2060 it is not the correct path.  
Use `sdpa` (already fast/stable and GPU-enabled).

## 2) Required runtime config (PowerShell)

From `tts-server` folder:

```powershell
$env:TTS_BACKEND="optimized"
$env:TTS_CONFIG="$PWD\config.yaml"
$env:FORCED_VOICE_PROFILE="Mario"
$env:VOICE_LIBRARY_DIR="$PWD\voice_library"
python -m api.main
```

Or load the local `.env` first, then start:

```powershell
Get-Content .env | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  [Environment]::SetEnvironmentVariable($k, $v, 'Process')
}
python -m api.main
```

Notes:
- `FORCED_VOICE_PROFILE=Mario` forces every request to use `clone:Mario`.
- `optimized` backend caches voice-clone prompt (`cache_key`) and reuses it on next requests.

## 3) config.yaml target (already aligned)

Keep:
- `default_model: 0.6B-CustomVoice` (for generic built-in TTS)
- `models.0.6B-Base` present (required for clone profiles)
- `optimization.attention: sdpa`

The backend auto-switches to Base when voice is `clone:Mario`.

## 4) Mario profile path

Profile must exist at:

`voice_library/profiles/mario/`

Required files:
- `meta.json`
- `reference.wav`
- `reference.txt` (recommended for ICL mode)

## 5) Confirm clone prompt cache is working

On first `clone:Mario` request you should see a log like:
- `Voice prompt cached for 'mario' (...)`

On subsequent requests:
- `Voice clone (cached prompt 'mario'): ...`

That means "clone once, reuse profile" is active.
## Cloud mode (Alibaba DashScope)

If you want cloud TTS instead of local GPU:

```powershell
$env:TTS_BACKEND="alibaba"
$env:DASHSCOPE_API_KEY="YOUR_KEY_HERE"
$env:DASHSCOPE_BASE_URL="https://dashscope-intl.aliyuncs.com/api/v1"
$env:DASHSCOPE_TTS_MODEL="qwen3-tts-vc-2026-01-22"
$env:DASHSCOPE_ENROLL_MODEL="qwen-voice-enrollment"
python -m api.main
```

Enroll a profile from audio:

`POST /v1/audio/voices/clone` with JSON:

```json
{
  "audioBase64": "<base64-audio>",
  "mimeType": "audio/wav",
  "name": "Mario",
  "language": "it"
}
```
