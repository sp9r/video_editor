# Spectra Video Studio

一般的なYouTube動画を、素材の読み込み、タイムライン編集、字幕・画像・音声の合成、H.264/AAC書き出しまで一つのデスクトップアプリで制作するための、クロスプラットフォーム動画編集ソフトです。

> [!IMPORTANT]
> 現在は **0.1.0 実用アルファの開発途中** です。編集UI、非破壊プロジェクト、FFmpeg書き出し、GPU自動検査、CPUフォールバック、AI拡張基盤まで実装されていますが、Premiere Pro / DaVinci Resolve / Final Cut Proと全機能・全性能が同等の完成版ではありません。現在地点と未完了項目は [HANDOFF.md](./HANDOFF.md) を確認してください。

## 現在実装されているもの

- Electron + React + TypeScriptによる独自デスクトップUI
- 動画・音声・画像のファイル選択／ドラッグ＆ドロップ読み込み
- 複数の映像・音声・字幕トラック
- クリップ配置、移動、トリミング、分割、通常削除、自動詰め削除
- 位置、拡大率、回転、不透明度、4辺クロップ
- 音量、パン、フェードイン／アウト、ミュート
- 字幕の本文・時刻・フォント・色・縁・影・背景・位置の編集
- `none` / `fade` / `pop` / `slide-up` / `typewriter` 字幕効果プリセット
- SRT / WebVTT読み込み、SRT出力、ASS/libassによる字幕焼き込み
- `.spectra`プロジェクト保存、相対パス、素材オフライン検出、再リンク用API
- Undo / Redo、recovery自動保存
- NVENC / Intel QSV / AMD AMF / Apple VideoToolbox / VAAPIの実エンコード検査
- GPU失敗時の`libx264` CPUフォールバック
- 一時出力、進捗、キャンセル、ffprobe＋先頭／末尾デコード検証
- Whisper、ローカルLLM、OpenAI互換API、将来のCodex連携を追加できるAI provider基盤

## 開発環境で起動する

必要環境はNode.js 22.12以上とGitです。FFmpeg / ffprobeはnpm依存として導入され、利用者のPATHへ依存しません。

```powershell
git clone <repository-url>
cd video_editor
npm.cmd install
npm.cmd run dev
```

Windows PowerShellの実行ポリシーで`npm.ps1`が拒否される場合があるため、この文書では`npm.cmd`を使います。

本番用のコードを生成して起動する場合:

```powershell
npm.cmd run build
npm.cmd run preview
```

## テスト

```powershell
npm.cmd run check
```

2026-08-12の最新確認では、型検査成功、12テストファイル／54テスト成功です。同梱FFmpegを実際に起動し、lossless fixture生成からクロップ・画像・音声・日本語字幕を含むH.264/AAC MP4の完成検証まで通しています。AMD AMFとCPU `libx264` でも、H.264/AAC MP4のffprobeおよび先頭・末尾frame decodeを確認しました（UI経由の受入試験は未完了）。

Windows配布物の予定コマンド:

```powershell
npm.cmd run dist:win
```

`release/` にはWindows x64の次の生成物が出力されます（Git管理外）。

- `Spectra Video Studio-0.1.0-win-x64-setup.exe`（NSIS installer）
- `Spectra Video Studio-0.1.0-win-x64-portable.exe`（portable）

> [!WARNING]
> このPCではunpacked／portableの起動プロセスと同梱FFmpeg/ffprobeの解決までを確認しています。インストーラーの対話的な導入・アンインストール、別PCへの移植、Intel／NVIDIA実機のGPU検出・CPU fallbackは未受入です。現時点で「別PCへコピーすれば確実に使える」とは扱わないでください。

## 最短の編集手順

1. `npm.cmd run dev`で起動する。
2. 左のメディア棚の`+`から動画・音声・画像を読み込む。
3. 素材を対応するV/Aトラックへドラッグする。
4. クリップ端をドラッグしてトリミングし、再生位置で`Ctrl+K`を押して分割する。
5. インスペクタでクロップ、位置、音量、フェードを調整する。
6. 「字幕を追加」または「SRT/VTT読込」で字幕を置き、右側でスタイルを設定する。
7. `Ctrl+S`で`.spectra`プロジェクトを保存する。
8. 「書き出す」でプリセット、GPU優先／CPU、字幕、保存先を確認してMP4を生成する。GPU優先時も失敗すればCPUへ安全に切り替わる。

詳しい操作は [USER_GUIDE.md](./docs/USER_GUIDE.md) を参照してください。

## 対応方針

| OS / GPU | H.264候補 | 動作方針 |
|---|---|---|
| Windows + NVIDIA | `h264_nvenc` | 実probe成功時に使用 |
| Windows + Intel | `h264_qsv` | 実probe成功時に使用 |
| Windows + AMD | `h264_amf` | 実probe成功時に使用 |
| macOS | `h264_videotoolbox` | macOS build上で実probe |
| Linux | NVENC / QSV / AMF / VAAPI | 対応driver/deviceを実probe |
| GPUなし／失敗 | `libx264` | 自動的にCPUで再試行 |

GPU decodeは初版では強制しません。クロップ・overlay・字幕・音声mixは互換性を優先してsoftware filterで処理し、最終エンコードだけをGPUへ渡します。

## 文書

- [利用者ガイド](./docs/USER_GUIDE.md)
- [機能仕様書](./docs/SPECIFICATION.md)
- [UI仕様](./docs/UI_SPEC.md)
- [アーキテクチャ](./docs/ARCHITECTURE.md)
- [エンコード実装](./docs/ENCODING.md)
- [AI拡張ガイド](./docs/AI_EXTENSION_GUIDE.md)
- [次担当への引き継ぎ](./HANDOFF.md)
- [変更履歴](./CHANGELOG.md)

## ライセンスと注意

アプリコードはMIT Licenseです。同梱するFFmpeg binaryの構成にはGPL/LGPL上の条件が別途適用されます。公開配布前に`ffmpeg -version`のconfigure情報、該当license、source offer等を確認し、[NOTICE.md](./NOTICE.md)と配布物を整備してください。

Adobe、DaVinci Resolve、Final Cut Proのロゴ、画面、アイコン、素材、コードは含んでいません。
