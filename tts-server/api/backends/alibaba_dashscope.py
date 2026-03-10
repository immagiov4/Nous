# coding=utf-8
# SPDX-License-Identifier: Apache-2.0
"""
Alibaba Cloud DashScope backend for OpenAI-compatible TTS API.
"""

import base64
import io
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import httpx
import numpy as np
import soundfile as sf

from .base import TTSBackend

logger = logging.getLogger(__name__)


class AlibabaDashScopeBackend(TTSBackend):
    """TTS backend powered by Alibaba Cloud DashScope."""

    def __init__(self) -> None:
        super().__init__()
        self._ready = False
        self.api_key = os.getenv("DASHSCOPE_API_KEY", "")
        self.base_url = os.getenv("DASHSCOPE_BASE_URL", "https://dashscope-intl.aliyuncs.com/api/v1").rstrip("/")
        self.tts_model = os.getenv("DASHSCOPE_TTS_MODEL", "qwen3-tts-vc-2026-01-22")
        self.enroll_model = os.getenv("DASHSCOPE_ENROLL_MODEL", "qwen-voice-enrollment")
        self._default_voices = {
            "marco": os.getenv("ALIBABA_VOICE_MARCO", "Cherry"),
            "giulia": os.getenv("ALIBABA_VOICE_GIULIA", "Serena"),
            "mario": os.getenv("ALIBABA_VOICE_MARIO", "Cherry"),
        }
        self._language_map = {
            "auto": "Auto",
            "it": "Italian",
            "en": "English",
            "zh": "Chinese",
            "ja": "Japanese",
            "ko": "Korean",
            "de": "German",
            "fr": "French",
            "es": "Spanish",
            "ru": "Russian",
            "pt": "Portuguese",
        }

    async def initialize(self) -> None:
        if self._ready:
            return
        if not self.api_key:
            raise RuntimeError(
                "DASHSCOPE_API_KEY is not set. Configure it in environment/.env to use TTS_BACKEND=alibaba."
            )
        self.device = "cloud"
        self.dtype = "remote"
        self._ready = True
        logger.info("Alibaba DashScope backend ready")

    async def _post_json(self, path: str, payload: Dict[str, Any], timeout: float = 120.0) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"DashScope request failed ({resp.status_code}): {resp.text}")
        try:
            data = resp.json()
        except Exception as exc:
            raise RuntimeError(f"DashScope response is not valid JSON: {exc}")
        if data.get("code"):
            raise RuntimeError(f"DashScope error {data.get('code')}: {data.get('message')}")
        return data

    async def _fetch_audio_from_url(self, url: str) -> Tuple[np.ndarray, int]:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to download audio from DashScope URL ({resp.status_code})")
        audio_bytes = resp.content
        audio, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
        if len(audio.shape) > 1:
            audio = audio.mean(axis=1)
        return audio.astype(np.float32), int(sr)

    async def generate_speech(
        self,
        text: str,
        voice: str,
        language: str = "Auto",
        instruct: Optional[str] = None,
        speed: float = 1.0,
    ) -> Tuple[np.ndarray, int]:
        if not self._ready:
            await self.initialize()

        resolved_voice = self._default_voices.get(voice.lower(), voice)
        resolved_language = self._language_map.get((language or "Auto").lower(), language or "Auto")
        payload: Dict[str, Any] = {
            "model": self.tts_model,
            "input": {
                "text": text,
                "voice": resolved_voice,
            },
        }
        if resolved_language and resolved_language != "Auto":
            payload["input"]["language_type"] = resolved_language
        if instruct:
            payload["input"]["instructions"] = instruct
            payload["input"]["optimize_instructions"] = True
        if speed != 1.0:
            logger.info("Speed parameter %.2f requested; DashScope model-side speed control may vary by model.", speed)

        try:
            result = await self._post_json(
                "/services/aigc/multimodal-generation/generation",
                payload,
            )
        except Exception as exc:
            logger.error(
                "DashScope TTS request failed: model=%s voice=%s language=%s error=%s",
                self.tts_model,
                resolved_voice,
                resolved_language,
                exc,
            )
            raise
        audio_obj = (((result.get("output") or {}).get("audio")) or {})
        audio_url = audio_obj.get("url")
        audio_b64 = audio_obj.get("data")
        if audio_url:
            return await self._fetch_audio_from_url(audio_url)
        if audio_b64:
            raw = base64.b64decode(audio_b64)
            audio, sr = sf.read(io.BytesIO(raw), dtype="float32")
            if len(audio.shape) > 1:
                audio = audio.mean(axis=1)
            return audio.astype(np.float32), int(sr)
        raise RuntimeError("DashScope response has no audio url/data")

    async def enroll_voice_from_audio(
        self,
        audio_base64: str,
        mime_type: str,
        preferred_name: str,
        language: str = "it",
    ) -> Dict[str, Any]:
        if not self._ready:
            await self.initialize()

        safe_name = re.sub(r"[^A-Za-z0-9_]", "_", preferred_name or "voice")[:16] or "voice"
        data_uri = f"data:{mime_type};base64,{audio_base64}"
        payload: Dict[str, Any] = {
            "model": self.enroll_model,
            "input": {
                "action": "create",
                "target_model": self.tts_model,
                "preferred_name": safe_name,
                "language": language,
                "audio": {"data": data_uri},
            },
        }
        result = await self._post_json("/services/audio/tts/customization", payload, timeout=180.0)
        voice_id = ((result.get("output") or {}).get("voice")) or ""
        if not voice_id:
            raise RuntimeError(f"Unexpected enrollment response: {result}")
        return {
            "voice_id": voice_id,
            "target_model": self.tts_model,
            "preferred_name": safe_name,
        }

    def get_backend_name(self) -> str:
        return "alibaba"

    def get_model_id(self) -> str:
        return self.tts_model

    def get_supported_voices(self) -> List[str]:
        return ["Marco", "Giulia", "Mario"]

    def get_supported_languages(self) -> List[str]:
        return [
            "Auto", "Chinese", "English", "German", "Italian", "Portuguese",
            "Spanish", "Japanese", "Korean", "French", "Russian",
        ]

    def is_ready(self) -> bool:
        return self._ready

    def get_device_info(self) -> Dict[str, Any]:
        return {
            "device": "cloud",
            "gpu_available": True,
            "gpu_name": "Alibaba Cloud Model Studio (remote)",
            "vram_total": "n/a",
            "vram_used": "n/a",
        }

    def supports_voice_cloning(self) -> bool:
        # This backend uses cloud voice enrollment (voice_id), not local reference-audio cloning.
        return False

    def get_model_type(self) -> str:
        return "cloud"
