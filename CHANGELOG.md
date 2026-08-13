# 変更履歴

このプロジェクトはSemantic Versioningを目標とし、ユーザーから見える変更を記録します。

## [Unreleased]

### Fixed

- offline素材をメディア棚から再リンクし、既存timeline clipのasset IDを保ったままpath／metadataを更新できるようにした。
- 書き出し画面の「ハードウェア」を「ハードウェア優先」へ改め、GPU失敗時にCPUへfallbackする実装と説明を一致させた。
- Windows NSIS installerとportableが同一ファイル名で上書きされる設定を修正し、`-setup.exe`と`-portable.exe`を別々に生成するようにした。

### Verified

- 12 test files／54 tests、AMD AMFとCPU `libx264` の実H.264/AAC MP4出力・ffprobe・先頭／末尾decode、Windows x64 package buildを確認した。

### Planned

- Electron実画面E2Eと別PC受入試験（未完了）
- 実program monitorの複数映像・音声同期、proxy、波形
- native dialogを含むoffline素材再リンクの実画面受入
- Windows installerの対話導入・アンインストールと別PC移植
- Whisper／ローカルLLM／OpenAI互換providerのUI統合
- より高度な字幕animation、transition、color、keyframe

## [0.1.0] - 2026-08-12

### Added

- Electron / React / TypeScriptのデスクトップ動画編集基盤
- 独自の黒鉛＋ミント編集ワークスペース
- メディア棚、program monitor、inspector、5 track timeline
- 移動、trim、split、delete、ripple delete、Undo / Redo
- crop、position、scale、rotation、opacity
- volume、pan、fade、track mute
- 字幕編集、style、5種類のeffect preset、SRT/VTT import、SRT export、ASS burn-in
- `.spectra`project、relative path、offline検出、recovery autosave
- 同梱FFmpeg / ffprobeの解決と安全なargv実行
- NVENC、QSV、AMF、VideoToolbox、VAAPI、libx264 adapter
- GPU実encode probe、CPU fallback、progress、cancel、partial output、完成検証
- path-free AI provider registry、mock、local LLM／OpenAI互換HTTP adapter、検証済み編集command
- 12 test files／53 testsとbundled FFmpeg integration test

### Known limitations

- 実用アルファ。program monitorの合成・音声再生、proxy／波形は未完成。
- Windows配布物と他PCでの受入試験は未完了。
- 高度なprofessional NLE機能と実AI providerはロードマップ段階。
