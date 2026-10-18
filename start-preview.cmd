@echo off
setlocal
chcp 65001 >nul
set "spectra_preview_exe=%~dp0release\local-preview\win-unpacked\Spectra Video Studio.exe"
if not exist "%spectra_preview_exe%" (
  echo 確認版の実行ファイルがありません。HANDOFF.mdの作成手順を確認してください。
  pause
  exit /b 1
)
rem Keep worker discovery available in this local packaged preview.
set "SPECTRA_AUTO_CAPTION_WORKER_ROOT=%~dp0..\clip_automation"
start "" "%spectra_preview_exe%"
