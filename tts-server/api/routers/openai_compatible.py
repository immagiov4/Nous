# coding=utf-8
# SPDX-License-Identifier: Apache-2.0
"""
OpenAI-compatible router for text-to-speech API.
Implements endpoints compatible with OpenAI's TTS API specification.
"""

import asyncio
import base64
import io
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import List, Optional

import numpy as np
import soundfile as sf
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

from ..structures.schemas import (
    OpenAISpeechRequest,
    ModelInfo,
    VoiceInfo,
    VoiceCloneRequest,
    VoiceCloneCapabilities,
    CloudVoiceEnrollmentRequest,
    CloudVoiceEnrollmentResponse,
)
from ..services.text_processing import normalize_text
from ..services.audio_encoding import encode_audio, get_content_type, DEFAULT_SAMPLE_RATE

logger = logging.getLogger(__name__)

# Concurrency cap: prevents simultaneous requests from starving GPU memory.
# Override with TTS_MAX_CONCURRENT env var (default 1 for single-GPU deployments).
try:
    _MAX_CONCURRENT = max(1, int(os.getenv("TTS_MAX_CONCURRENT", "1")))
except ValueError:
    logger.warning("Invalid TTS_MAX_CONCURRENT value; falling back to 1")
    _MAX_CONCURRENT = 1
_generation_semaphore = asyncio.Semaphore(_MAX_CONCURRENT)

# Voice library: saved voice profiles used via the "clone:ProfileName" voice prefix.
# Configurable via VOICE_LIBRARY_DIR env var; defaults to ./voice_library.
VOICE_LIBRARY_DIR = Path(
    os.environ.get("VOICE_LIBRARY_DIR", "./voice_library")
).resolve()
FORCED_VOICE_PROFILE = os.environ.get("FORCED_VOICE_PROFILE", "Mario")
FORCED_CLONE_VOICE = f"clone:{FORCED_VOICE_PROFILE}"

# In-process cache for reference audio reads (profile_name -> (audio_np, sample_rate)).
# Avoids re-reading and re-decoding the same WAV file on every request.
_ref_audio_cache: dict = {}

router = APIRouter(
    tags=["OpenAI Compatible TTS"],
    responses={404: {"description": "Not found"}},
)


# Language code to language name mapping
LANGUAGE_CODE_MAPPING = {
    "en": "English",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "ru": "Russian",
    "pt": "Portuguese",
    "it": "Italian",
}

# Available models (including language-specific variants)
AVAILABLE_MODELS = [
    ModelInfo(
        id="qwen3-tts",
        object="model",
        created=1737734400,  # 2025-01-24
        owned_by="qwen",
    ),
    ModelInfo(
        id="tts-1",
        object="model",
        created=1737734400,
        owned_by="qwen",
    ),
    ModelInfo(
        id="tts-1-hd",
        object="model",
        created=1737734400,
        owned_by="qwen",
    ),
]

# Add language-specific model variants
for lang_code in LANGUAGE_CODE_MAPPING.keys():
    AVAILABLE_MODELS.extend([
        ModelInfo(
            id=f"tts-1-{lang_code}",
            object="model",
            created=1737734400,
            owned_by="qwen",
        ),
        ModelInfo(
            id=f"tts-1-hd-{lang_code}",
            object="model",
            created=1737734400,
            owned_by="qwen",
        ),
    ])

# Model name mapping (OpenAI -> internal)
MODEL_MAPPING = {
    "tts-1": "qwen3-tts",
    "tts-1-hd": "qwen3-tts",
    "qwen3-tts": "qwen3-tts",
}

# Add language-specific model mappings
for lang_code in LANGUAGE_CODE_MAPPING.keys():
    MODEL_MAPPING[f"tts-1-{lang_code}"] = "qwen3-tts"
    MODEL_MAPPING[f"tts-1-hd-{lang_code}"] = "qwen3-tts"

# OpenAI voice mapping to Qwen voices
VOICE_MAPPING = {
    "alloy": "Vivian",
    "echo": "Ryan",
    "fable": "Sophia",
    "nova": "Isabella",
    "onyx": "Evan",
    "shimmer": "Lily",
}


def extract_language_from_model(model_name: str) -> Optional[str]:
    """
    Extract language from model name if it has a language suffix.
    
    Args:
        model_name: Model name (e.g., "tts-1-es", "tts-1-hd-fr")
    
    Returns:
        Language name if suffix found, None otherwise
    """
    # Check if model ends with a language code
    # Only extract language if the model follows the expected pattern
    for lang_code, lang_name in LANGUAGE_CODE_MAPPING.items():
        suffix = f"-{lang_code}"
        if model_name.endswith(suffix):
            # Verify it's a valid language-specific model variant
            # Should be either tts-1-{lang} or tts-1-hd-{lang}
            if model_name == f"tts-1{suffix}" or model_name == f"tts-1-hd{suffix}":
                return lang_name
    return None


def _load_voice_profile(name_or_id: str) -> dict:
    """Load a voice profile by name or profile_id from the voice library.

    Searches ``VOICE_LIBRARY_DIR/profiles/`` for a sub-directory whose
    ``meta.json`` matches the given *name_or_id* (case-insensitive name match
    or exact profile_id match).

    Returns a dict with keys:
        ref_audio_path, ref_text, x_vector_only_mode, language, name

    Raises:
        ValueError: if the profile is not found or its reference audio is missing.
    """
    profiles_dir = VOICE_LIBRARY_DIR / "profiles"
    if not profiles_dir.exists():
        raise ValueError(f"Voice library not found: {profiles_dir}")

    for child in sorted(profiles_dir.iterdir()):
        if not child.is_dir():
            continue
        meta_file = child / "meta.json"
        if not meta_file.exists():
            continue
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
        except Exception:
            continue

        if (
            meta.get("profile_id") == name_or_id
            or meta.get("name", "").lower() == name_or_id.lower()
        ):
            ref_filename = meta.get("ref_audio_filename", "")
            ref_path = None
            if ref_filename:
                candidate = child / ref_filename
                if candidate.exists():
                    ref_path = candidate

            voice_id = meta.get("voice_id") or meta.get("voiceId")
            if not ref_path and not voice_id:
                raise ValueError(
                    f"Profile '{name_or_id}' has neither a valid reference audio nor a cloud voice_id"
                )
            return {
                "ref_audio_path": str(ref_path) if ref_path else None,
                "ref_text": meta.get("ref_text", ""),
                "x_vector_only_mode": meta.get("x_vector_only_mode", False),
                "language": meta.get("language", "Auto"),
                "name": meta.get("name", name_or_id),
                "voice_id": voice_id,
            }

    raise ValueError(f"Voice profile not found: '{name_or_id}'")


async def get_tts_backend():
    """Get the TTS backend instance, initializing if needed."""
    from ..backends import get_backend, initialize_backend
    
    backend = get_backend()
    
    if not backend.is_ready():
        await initialize_backend()
    
    return backend


def get_voice_name(voice: str) -> str:
    """Map voice name to internal voice identifier."""
    # Check OpenAI voice mapping first
    if voice.lower() in VOICE_MAPPING:
        return VOICE_MAPPING[voice.lower()]
    # Otherwise use the voice name directly
    return voice


async def generate_speech(
    text: str,
    voice: str,
    language: str = "Auto",
    instruct: Optional[str] = None,
    speed: float = 1.0,
) -> tuple[np.ndarray, int]:
    """
    Generate speech from text using the configured TTS backend.
    
    Args:
        text: The text to synthesize
        voice: Voice name to use
        language: Language code
        instruct: Optional instruction for voice style
        speed: Speech speed multiplier
    
    Returns:
        Tuple of (audio_array, sample_rate)
    """
    backend = await get_tts_backend()

    # Check custom voice BEFORE applying OpenAI alias mapping,
    # so custom voices with OpenAI alias names remain accessible.
    if backend.is_custom_voice(voice):
        try:
            audio, sr = await backend.generate_speech_with_custom_voice(
                text=text,
                voice=voice,
                language=language,
                speed=speed,
            )
            return audio, sr
        except Exception as e:
            raise RuntimeError(f"Speech generation failed: {e}")

    # Map voice name (OpenAI aliases to internal names)
    voice_name = get_voice_name(voice)
    
    # Generate speech using the backend
    try:
        audio, sr = await backend.generate_speech(
            text=text,
            voice=voice_name,
            language=language,
            instruct=instruct,
            speed=speed,
        )
        
        return audio, sr
        
    except Exception as e:
        raise RuntimeError(f"Speech generation failed: {e}")


@router.post("/audio/speech")
async def create_speech(
    request: OpenAISpeechRequest,
    client_request: Request,
):
    """
    OpenAI-compatible endpoint for text-to-speech.

    Generates audio from the input text using the specified voice and model.

    **Voice library:** pass ``voice: "clone:ProfileName"`` to use a saved voice
    profile from the voice library (``VOICE_LIBRARY_DIR/profiles/``).  The
    server automatically switches to the Base model for profile-based cloning.

    **Real-time streaming:** set ``stream: true`` together with
    ``response_format: "pcm"`` to receive raw PCM chunks as the model generates
    audio (requires the *optimized* backend; other backends fall back to chunked
    delivery of fully-generated audio).
    """
    # Validate model
    if request.model not in MODEL_MAPPING:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_model",
                "message": f"Unsupported model: {request.model}. Supported: {list(MODEL_MAPPING.keys())}",
                "type": "invalid_request_error",
            },
        )
    
    try:
        # Force all synthesis requests to use only the configured clone profile.
        if request.voice != FORCED_CLONE_VOICE:
            logger.info(
                f"Overriding requested voice '{request.voice}' -> '{FORCED_CLONE_VOICE}'"
            )
        request.voice = FORCED_CLONE_VOICE

        # Normalize input text
        normalized_text = normalize_text(request.input, request.normalization_options)
        
        if not normalized_text.strip():
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "invalid_input",
                    "message": "Input text is empty after normalization",
                    "type": "invalid_request_error",
                },
            )
        
        # Extract language from model name if present, otherwise use request language
        model_language = extract_language_from_model(request.model)
        language = model_language if model_language else (request.language or "Auto")

        # ----------------------------------------------------------------
        # Voice library: "clone:ProfileName" -> load profile + voice clone
        # ----------------------------------------------------------------
        if request.voice.lower().startswith("clone:"):
            profile_name = request.voice[len("clone:"):].strip()
            if not profile_name:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": "invalid_voice",
                        "message": (
                            "The 'clone:' prefix requires a profile name, "
                            "e.g. voice='clone:MyVoice'"
                        ),
                        "type": "invalid_request_error",
                    },
                )
            try:
                profile = _load_voice_profile(profile_name)
            except ValueError as exc:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "error": "profile_not_found",
                        "message": str(exc),
                        "type": "invalid_request_error",
                    },
                )

            backend = await get_tts_backend()
            clone_lang = (
                language if language != "Auto" else profile["language"]
            )

            # Cloud path: if profile has voice_id and backend is Alibaba, synthesize directly.
            if backend.get_backend_name() == "alibaba" and profile.get("voice_id"):
                logger.info(
                    f"Cloud voice profile '{profile['name']}' via Alibaba: "
                    f"lang={clone_lang}, stream={request.stream}"
                )
                async with _generation_semaphore:
                    audio, sample_rate = await backend.generate_speech(
                        text=normalized_text,
                        voice=profile["voice_id"],
                        language=clone_lang,
                        instruct=request.instruct,
                        speed=request.speed,
                    )
                fmt = request.response_format
                audio_bytes = await asyncio.to_thread(encode_audio, audio, fmt, sample_rate)
                content_type = get_content_type(fmt)
                return Response(
                    content=audio_bytes,
                    media_type=content_type,
                    headers={
                        "Content-Disposition": f"inline; filename=speech.{fmt}",
                        "Cache-Control": "no-cache",
                    },
                )
            if backend.get_backend_name() == "alibaba" and not profile.get("voice_id"):
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": "missing_cloud_voice_id",
                        "message": (
                            f"Profile '{profile['name']}' has no cloud voice_id. "
                            "Enroll it first via POST /v1/audio/voices/clone."
                        ),
                        "type": "invalid_request_error",
                    },
                )

            # Check that voice cloning is supported by the current backend/model
            if not backend.supports_voice_cloning():
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": "voice_cloning_not_supported",
                        "message": (
                            "Voice library cloning requires a Base model and the "
                            "optimized backend (TTS_BACKEND=optimized), or a backend "
                            "that supports voice cloning."
                        ),
                        "type": "invalid_request_error",
                    },
                )

            # ICL mode (x_vector_only_mode=False) requires a ref_text transcript
            if not profile["x_vector_only_mode"] and not profile["ref_text"]:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": "missing_ref_text",
                        "message": (
                            f"Profile '{profile['name']}' is configured for ICL mode "
                            "(x_vector_only_mode=false) but has no ref_text. "
                            "Add a transcript to meta.json or set x_vector_only_mode=true."
                        ),
                        "type": "invalid_request_error",
                    },
                )

            # Normalize cache key to canonical profile name (case-insensitive safe)
            canonical_key = profile["name"].lower()

            # Cache reference audio reads to avoid repeated disk I/O
            ref_audio_path = profile["ref_audio_path"]
            if not ref_audio_path:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": "profile_missing_reference",
                        "message": (
                            f"Profile '{profile['name']}' has no local reference audio "
                            "for this backend."
                        ),
                        "type": "invalid_request_error",
                    },
                )
            if canonical_key not in _ref_audio_cache:
                try:
                    ref_audio_np, ref_sr = sf.read(ref_audio_path)
                    if len(ref_audio_np.shape) > 1:
                        ref_audio_np = ref_audio_np.mean(axis=1)
                    ref_audio_np = ref_audio_np.astype(np.float32)
                    _ref_audio_cache[canonical_key] = (ref_audio_np, ref_sr)
                    logger.info(f"Reference audio cached for profile '{profile['name']}'")
                except Exception as exc:
                    raise HTTPException(
                        status_code=400,
                        detail={
                            "error": "audio_processing_error",
                            "message": (
                                f"Failed to load reference audio for profile "
                                f"'{profile['name']}': {exc}"
                            ),
                            "type": "invalid_request_error",
                        },
                    )
            ref_audio_np, ref_sr = _ref_audio_cache[canonical_key]

            logger.info(
                f"Voice library clone '{profile['name']}': "
                f"lang={clone_lang}, "
                f"x_vector_only={profile['x_vector_only_mode']}, "
                f"stream={request.stream}"
            )

            if request.stream and hasattr(backend, "generate_voice_clone_streaming"):
                # Streaming: only PCM and WAV→PCM are valid
                if request.response_format not in ("pcm", "wav"):
                    raise HTTPException(
                        status_code=400,
                        detail={
                            "error": "invalid_format_for_streaming",
                            "message": (
                                f"Real-time streaming only supports response_format "
                                f"'pcm' (raw float32). Got '{request.response_format}'. "
                                "Use stream=false for compressed formats."
                            ),
                            "type": "invalid_request_error",
                        },
                    )
                fmt = "pcm"
                content_type = get_content_type(fmt)

                async def _clone_stream():
                    gen_start = time.time()
                    first_chunk_logged = False
                    total_samples = 0
                    chunk_count = 0
                    sample_rate = 24000
                    async with _generation_semaphore:
                        async for pcm_chunk, sr in backend.generate_voice_clone_streaming(
                            text=normalized_text,
                            ref_audio=ref_audio_np,
                            ref_audio_sr=ref_sr,
                            ref_text=profile["ref_text"] or None,
                            language=clone_lang,
                            x_vector_only_mode=profile["x_vector_only_mode"],
                            cache_key=canonical_key,
                        ):
                            if pcm_chunk is not None and len(pcm_chunk) > 0:
                                if not first_chunk_logged:
                                    logger.info(
                                        f"Voice clone stream TTFB: "
                                        f"{time.time()-gen_start:.3f}s"
                                    )
                                    first_chunk_logged = True
                                total_samples += len(pcm_chunk)
                                sample_rate = sr
                                chunk_count += 1
                                yield encode_audio(pcm_chunk, fmt, sr)
                                await asyncio.sleep(0)
                    gen_time = time.time() - gen_start
                    audio_dur = total_samples / sample_rate if sample_rate > 0 else 0
                    rtf = gen_time / audio_dur if audio_dur > 0 else 0
                    logger.info(
                        f"Voice clone stream done: "
                        f"total={gen_time:.2f}s audio={audio_dur:.2f}s "
                        f"RTF={rtf:.2f}x chunks={chunk_count}"
                    )

                return StreamingResponse(
                    _clone_stream(),
                    media_type=content_type,
                    headers={
                        "Content-Disposition": f"inline; filename=speech.{fmt}",
                        "Cache-Control": "no-cache",
                    },
                )
            else:
                # Non-streaming path — honor the requested format (including wav)
                gen_start = time.time()
                async with _generation_semaphore:
                    audio, sample_rate = await backend.generate_voice_clone(
                        text=normalized_text,
                        ref_audio=ref_audio_np,
                        ref_audio_sr=ref_sr,
                        ref_text=profile["ref_text"] or None,
                        language=clone_lang,
                        x_vector_only_mode=profile["x_vector_only_mode"],
                        speed=request.speed,
                        cache_key=canonical_key,
                    )
                gen_time = time.time() - gen_start
                audio_dur = len(audio) / sample_rate if sample_rate > 0 else 0
                rtf = gen_time / audio_dur if audio_dur > 0 else 0
                logger.info(
                    f"Voice clone done: gen={gen_time:.2f}s "
                    f"audio={audio_dur:.2f}s RTF={rtf:.2f}x"
                )

                fmt = request.response_format
                audio_bytes = await asyncio.to_thread(encode_audio, audio, fmt, sample_rate)
                content_type = get_content_type(fmt)

                return Response(
                    content=audio_bytes,
                    media_type=content_type,
                    headers={
                        "Content-Disposition": f"inline; filename=speech.{fmt}",
                        "Cache-Control": "no-cache",
                    },
                )

        # ----------------------------------------------------------------
        # Real-time streaming for built-in voices (optimized backend only)
        # ----------------------------------------------------------------
        if request.stream:
            backend = await get_tts_backend()
            if hasattr(backend, "generate_speech_streaming"):
                # Streaming: only PCM and WAV→PCM are valid (compressed formats
                # produce invalid streams when per-chunk encode_audio is concatenated)
                if request.response_format not in ("pcm", "wav"):
                    raise HTTPException(
                        status_code=400,
                        detail={
                            "error": "invalid_format_for_streaming",
                            "message": (
                                f"Real-time streaming only supports response_format "
                                f"'pcm' (raw float32). Got '{request.response_format}'. "
                                "Use stream=false for compressed formats."
                            ),
                            "type": "invalid_request_error",
                        },
                    )
                voice_name = get_voice_name(request.voice)
                fmt = "pcm"
                content_type = get_content_type(fmt)

                async def _speech_stream():
                    gen_start = time.time()
                    first_chunk_logged = False
                    total_samples = 0
                    chunk_count = 0
                    sample_rate = 24000
                    async with _generation_semaphore:
                        async for pcm_chunk, sr in backend.generate_speech_streaming(
                            text=normalized_text,
                            voice=voice_name,
                            language=language,
                            instruct=request.instruct,
                            model=request.model,
                        ):
                            if pcm_chunk is not None and len(pcm_chunk) > 0:
                                if not first_chunk_logged:
                                    logger.info(
                                        f"TTS stream TTFB: "
                                        f"{time.time()-gen_start:.3f}s"
                                    )
                                    first_chunk_logged = True
                                total_samples += len(pcm_chunk)
                                sample_rate = sr
                                chunk_count += 1
                                yield encode_audio(pcm_chunk, fmt, sr)
                                await asyncio.sleep(0)
                    gen_time = time.time() - gen_start
                    audio_dur = total_samples / sample_rate if sample_rate > 0 else 0
                    rtf = gen_time / audio_dur if audio_dur > 0 else 0
                    logger.info(
                        f"TTS stream done: total={gen_time:.2f}s "
                        f"audio={audio_dur:.2f}s RTF={rtf:.2f}x chunks={chunk_count}"
                    )

                return StreamingResponse(
                    _speech_stream(),
                    media_type=content_type,
                    headers={
                        "Content-Disposition": f"attachment; filename=speech.{fmt}",
                        "Cache-Control": "no-cache",
                    },
                )

        # ----------------------------------------------------------------
        # Non-streaming (or streaming fallback for non-optimized backends)
        # ----------------------------------------------------------------
        # Guard against concurrent overload
        async with _generation_semaphore:
            # Generate speech
            audio, sample_rate = await generate_speech(
                text=normalized_text,
                voice=request.voice,
                language=language,
                instruct=request.instruct,
                speed=request.speed,
            )

        # Get content type
        content_type = get_content_type(request.response_format)

        if request.stream:
            # Fallback streaming: generate fully then chunk (non-optimized backends)
            async def _pcm_chunks():
                chunk_size = 4096
                audio_bytes = await asyncio.to_thread(
                    encode_audio, audio, request.response_format, sample_rate
                )
                for i in range(0, len(audio_bytes), chunk_size):
                    yield audio_bytes[i:i + chunk_size]

            return StreamingResponse(
                _pcm_chunks(),
                media_type=content_type,
                headers={
                    "Content-Disposition": f"attachment; filename=speech.{request.response_format}",
                    "Cache-Control": "no-cache",
                },
            )

        # Encode audio to requested format (offloaded – pydub MP3 encoding is CPU-heavy)
        audio_bytes = await asyncio.to_thread(encode_audio, audio, request.response_format, sample_rate)

        # Return audio response
        return Response(
            content=audio_bytes,
            media_type=content_type,
            headers={
                "Content-Disposition": f"attachment; filename=speech.{request.response_format}",
                "Cache-Control": "no-cache",
            },
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={
                "error": "processing_error",
                "message": str(e),
                "type": "server_error",
            },
        )


@router.get("/models")
async def list_models():
    """List all available TTS models."""
    return {
        "object": "list",
        "data": [model.model_dump() for model in AVAILABLE_MODELS],
    }


@router.get("/models/{model_id}")
async def get_model(model_id: str):
    """Get information about a specific model."""
    for model in AVAILABLE_MODELS:
        if model.id == model_id:
            return model.model_dump()
    
    raise HTTPException(
        status_code=404,
        detail={
            "error": "model_not_found",
            "message": f"Model '{model_id}' not found",
            "type": "invalid_request_error",
        },
    )


@router.get("/audio/voices")
@router.get("/voices")
async def list_voices():
    """List all available voices for text-to-speech.

    Includes built-in Qwen3-TTS speakers, OpenAI-compatible aliases, and any
    saved voice profiles from the voice library (listed with a ``clone:`` prefix).
    """
    default_languages = ["Italian"]

    # Discover voice library profiles (clone: prefix voices)
    clone_voices: List[dict] = []
    profiles_dir = VOICE_LIBRARY_DIR / "profiles"
    if profiles_dir.exists():
        for child in sorted(profiles_dir.iterdir()):
            meta_file = child / "meta.json"
            if not meta_file.exists():
                continue
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
                ref_audio_filename = meta.get("ref_audio_filename")
                name = meta.get("name")
                if ref_audio_filename and isinstance(name, str) and name.strip():
                    clone_name = name.strip()
                    clone_id = f"clone:{clone_name}"
                    clone_voices.append(
                        VoiceInfo(
                            id=clone_id,
                            name=clone_id,
                            description=f"Voice library profile: {clone_name}",
                        ).model_dump()
                    )
                elif ref_audio_filename:
                    logger.warning(
                        "Skipping voice profile at %s due to invalid or missing 'name' in meta.json",
                        meta_file,
                    )
            except Exception:
                pass

    forced_id = FORCED_CLONE_VOICE
    forced_voice = next(
        (v for v in clone_voices if v.get("id", "").lower() == forced_id.lower()),
        None,
    )
    if forced_voice is None:
        forced_voice = VoiceInfo(
            id=forced_id,
            name=forced_id,
            language="Italian",
            description=(
                f"Forced voice profile: {FORCED_VOICE_PROFILE} "
                f"(missing under {VOICE_LIBRARY_DIR / 'profiles'})"
            ),
        ).model_dump()

    return {
        "voices": [forced_voice],
        "languages": default_languages,
    }


@router.get("/audio/voice-clone/capabilities")
async def get_voice_clone_capabilities():
    """
    Get voice cloning capabilities of the current backend.

    Returns whether voice cloning is supported and what modes are available.
    Voice cloning requires the Base model (Qwen3-TTS-12Hz-1.7B-Base).
    """
    try:
        backend = await get_tts_backend()

        supports_cloning = backend.supports_voice_cloning()
        model_type = backend.get_model_type() if hasattr(backend, 'get_model_type') else "unknown"

        return VoiceCloneCapabilities(
            supported=supports_cloning,
            model_type=model_type,
            icl_mode_available=supports_cloning,
            x_vector_mode_available=supports_cloning,
        )

    except Exception as e:
        logger.warning(f"Could not get voice clone capabilities: {e}")
        return VoiceCloneCapabilities(
            supported=False,
            model_type="unknown",
            icl_mode_available=False,
            x_vector_mode_available=False,
        )


@router.post("/audio/voice-clone")
async def create_voice_clone(
    request: VoiceCloneRequest,
    client_request: Request,
):
    """
    Clone a voice from reference audio and generate speech.

    This endpoint requires the Base model (Qwen3-TTS-12Hz-1.7B-Base).
    Set TTS_MODEL_NAME=Qwen/Qwen3-TTS-12Hz-1.7B-Base environment variable when starting the server.

    Two modes are available:
    - ICL mode (x_vector_only_mode=False): Requires ref_text transcript for best quality
    - X-Vector mode (x_vector_only_mode=True): No transcript needed, good quality
    """
    try:
        backend = await get_tts_backend()

        # Check if voice cloning is supported
        if not backend.supports_voice_cloning():
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "voice_cloning_not_supported",
                    "message": "Voice cloning requires the Base model (Qwen3-TTS-12Hz-1.7B-Base). "
                               "Set TTS_MODEL_NAME=Qwen/Qwen3-TTS-12Hz-1.7B-Base environment variable and restart the server.",
                    "type": "invalid_request_error",
                },
            )

        # Validate ICL mode requires ref_text
        if not request.x_vector_only_mode and not request.ref_text:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "missing_ref_text",
                    "message": "ICL mode requires ref_text (transcript of reference audio). "
                               "Either provide ref_text or set x_vector_only_mode=True.",
                    "type": "invalid_request_error",
                },
            )

        # Decode base64 audio
        try:
            audio_bytes = base64.b64decode(request.ref_audio)
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "invalid_audio",
                    "message": f"Failed to decode base64 audio: {e}",
                    "type": "invalid_request_error",
                },
            )

        # Load audio using soundfile
        try:
            audio_buffer = io.BytesIO(audio_bytes)
            ref_audio, ref_sr = sf.read(audio_buffer)

            # Convert to mono if stereo
            if len(ref_audio.shape) > 1:
                ref_audio = ref_audio.mean(axis=1)

            ref_audio = ref_audio.astype(np.float32)

        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "audio_processing_error",
                    "message": f"Failed to process reference audio: {e}. "
                               "Ensure the audio is a valid WAV, MP3, or other supported format.",
                    "type": "invalid_request_error",
                },
            )

        # Normalize input text
        normalized_text = normalize_text(request.input, request.normalization_options)

        if not normalized_text.strip():
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "invalid_input",
                    "message": "Input text is empty after normalization",
                    "type": "invalid_request_error",
                },
            )

        # Generate voice clone
        async with _generation_semaphore:
            audio, sample_rate = await backend.generate_voice_clone(
                text=normalized_text,
                ref_audio=ref_audio,
                ref_audio_sr=ref_sr,
                ref_text=request.ref_text,
                language=request.language or "Auto",
                x_vector_only_mode=request.x_vector_only_mode,
                speed=request.speed,
            )

        # Encode audio to requested format (offloaded – pydub MP3 encoding is CPU-heavy)
        audio_bytes = await asyncio.to_thread(encode_audio, audio, request.response_format, sample_rate)

        # Get content type
        content_type = get_content_type(request.response_format)

        # Return audio response
        return Response(
            content=audio_bytes,
            media_type=content_type,
            headers={
                "Content-Disposition": f"attachment; filename=voice_clone.{request.response_format}",
                "Cache-Control": "no-cache",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Voice cloning failed: {e}")
        raise HTTPException(
            status_code=500,
            detail={
                "error": "processing_error",
                "message": str(e),
                "type": "server_error",
            },
        )


@router.post("/audio/voices/clone")
async def create_cloud_voice_profile(request: CloudVoiceEnrollmentRequest):
    """
    Enroll a custom voice profile in cloud TTS and save it to voice_library.

    Requires TTS_BACKEND=alibaba.
    """
    try:
        backend = await get_tts_backend()
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "error": "enrollment_backend_init_failed",
                "message": str(exc),
                "type": "server_error",
            },
        )
    if backend.get_backend_name() != "alibaba" or not hasattr(backend, "enroll_voice_from_audio"):
        raise HTTPException(
            status_code=400,
            detail={
                "error": "unsupported_backend",
                "message": "This endpoint requires TTS_BACKEND=alibaba.",
                "type": "invalid_request_error",
            },
        )

    try:
        base64.b64decode(request.audio_base64)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_audio",
                "message": "audioBase64 is not valid base64.",
                "type": "invalid_request_error",
            },
        )

    try:
        enroll_result = await backend.enroll_voice_from_audio(
            audio_base64=request.audio_base64,
            mime_type=request.mime_type,
            preferred_name=request.name,
            language=request.language,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "error": "enrollment_failed",
                "message": str(exc),
                "type": "server_error",
            },
        )

    # Persist profile in the local voice library.
    safe_slug = re.sub(r"[^a-z0-9_-]+", "-", request.name.lower()).strip("-") or "voice"
    profile_dir = VOICE_LIBRARY_DIR / "profiles" / safe_slug
    profile_dir.mkdir(parents=True, exist_ok=True)

    ext_map = {
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/flac": "flac",
        "audio/ogg": "ogg",
        "audio/m4a": "m4a",
    }
    ext = ext_map.get(request.mime_type.lower(), "wav")
    ref_filename = f"reference.{ext}"
    ref_path = profile_dir / ref_filename
    ref_path.write_bytes(base64.b64decode(request.audio_base64))

    meta = {
        "name": request.name,
        "profile_id": safe_slug,
        "ref_audio_filename": ref_filename,
        "ref_text": "",
        "x_vector_only_mode": False,
        "language": request.language,
        "mode": "custom_voice",
        "voice_id": enroll_result["voice_id"],
        "target_model": enroll_result.get("target_model"),
    }
    (profile_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return CloudVoiceEnrollmentResponse(
        id=safe_slug,
        name=request.name,
        language=request.language,
        mode="custom_voice",
        voice_id=enroll_result["voice_id"],
        model_settings={"temperature": 0.7, "speed": 1.0},
    ).model_dump(by_alias=True)
