@echo off
setlocal

REM Usage:
REM   enroll-mario.bat
REM   enroll-mario.bat "C:\path\to\reference.wav" "Mario" "it"

set "WAV_PATH=%~1"
if "%WAV_PATH%"=="" set "WAV_PATH=%~dp0voice_library\profiles\mario\reference.wav"

set "VOICE_NAME=%~2"
if "%VOICE_NAME%"=="" set "VOICE_NAME=Mario"

set "LANG_CODE=%~3"
if "%LANG_CODE%"=="" set "LANG_CODE=it"

set "API_URL=http://localhost:8880/v1/audio/voices/clone"

echo [enroll-mario] WAV: %WAV_PATH%
echo [enroll-mario] Name: %VOICE_NAME%
echo [enroll-mario] Lang: %LANG_CODE%
echo [enroll-mario] URL:  %API_URL%

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$wav = '%WAV_PATH%';" ^
  "if (-not (Test-Path $wav)) { throw \"WAV not found: $wav\" };" ^
  "$audioBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($wav));" ^
  "$body = @{ audioBase64 = $audioBase64; mimeType = 'audio/wav'; name = '%VOICE_NAME%'; language = '%LANG_CODE%' } | ConvertTo-Json -Depth 5;" ^
  "try { $resp = Invoke-RestMethod -Method Post -Uri '%API_URL%' -ContentType 'application/json' -Body $body; Write-Host ''; Write-Host '[enroll-mario] Response:' -ForegroundColor Green; $resp | ConvertTo-Json -Depth 10 } catch { if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message -ForegroundColor Red }; throw }"

if errorlevel 1 (
  echo [enroll-mario] Enrollment failed.
  exit /b 1
)

echo.
echo [enroll-mario] Done.
exit /b 0
