@echo off
setlocal
chcp 65001 >nul
set "cutline_preview_exe=%~dp0release\local-preview-cutline-3\win-unpacked\Cutline.exe"
if not exist "%cutline_preview_exe%" (
  echo 確認版の実行ファイルがありません。HANDOFF.mdの作成手順を確認してください。
  pause
  exit /b 1
)
rem Keep worker discovery available in this local packaged preview.
set "SPECTRA_AUTO_CAPTION_WORKER_ROOT=%~dp0..\clip_automation"
start "" "%cutline_preview_exe%"
