# Cutline

動画・音声素材の読み込み、マルチトラックタイムライン編集、Whisper連携による自動字幕生成・無音カット、GPU実機検査付きH.264/AAC書き出しまでをローカル完結で行うクロスプラットフォーム動画編集ソフトです（Electron + React + TypeScript + FFmpeg）。

## アーキテクチャ概要

```mermaid
flowchart LR
  Media["入力動画・音声"] --> Probe["FFprobe / 波形・無音解析"]
  Probe --> Timeline["Electron + TypeScript タイムラインUI<br/>（マルチトラック・字幕スタイル・Undo/Redo）"]
  Timeline --> Sub["字幕レイアウト・自動無音カット生成"]
  Sub --> Render["FFmpeg レンダリングパイプライン<br/>（MP4 / 字幕焼き込み・書き出し）"]
```

## 設計上の特徴

- **非破壊プロジェクトモデル（`.cutline`）**: 相対パス解決、素材オフライン検出・再リンク、Undo / Redo、自動リカバリ保存を備え、Preview と Final Export で同一の Render Plan を共有します。
- **GPU実機プローブ＋CPU自動フォールバック**: `h264_nvenc` / `h264_qsv` / `h264_amf` / `h264_videotoolbox` を小さな実エンコードで事前検証し、未対応環境や失敗時は `libx264` へ安全に切り替えます。
- **単語単位の字幕データモデル**: 外部ワーカー（[clip_automation](https://github.com/sp9r/clip_automation)）とバージョン付きJSON契約（`edit_project.v1` / `auto_caption_worker_v1`）で連携し、文字起こしの生単語（`SubtitleWord`）と編集用字幕ブロック（`SubtitleEditUnit`）を分離して Razor 分割・結合・境界調整を行えます。
- **ヘッドレスCLI対応**: GUIを起動せずに `edit_project.v1` のスキーマ検証・FFprobe確認・Render Plan表示・MP4書き出しを実行できます。

## 主な実装機能

- Electron + React + TypeScript によるマルチトラックタイムライン（V/A/字幕トラック）
- 動画・音声・画像のドラッグ＆ドロップ読み込み、トリミング、分割（`Ctrl+K`）、自動詰め削除
- 映像クロップ（4辺）、位置、拡大率、回転、不透明度、音量・左右バランス・フェード
- 字幕の本文・時刻・フォント・色・縁・影・背景・プリセット効果（`none` / `fade` / `pop` / `slide-up` / `typewriter`）編集
- SRT / WebVTT 読み込み、SRT書き出し、ASS/libass 字幕焼き込み
- 一時出力・ffprobe検証・先頭/末尾デコード検証付きの安全な書き出しパイプライン

## 開発環境での起動・ビルド・テスト

必要環境は Node.js 22.12 以上と Git です（FFmpeg / ffprobe は npm 依存として同梱）。

```powershell
git clone https://github.com/sp9r/video_editor.git
cd video_editor
npm.cmd install
npm.cmd run dev
```

本番ビルド確認・型検査＆テスト・Windows配布物ビルド:

```powershell
npm.cmd run build
npm.cmd run preview
npm.cmd run check
npm.cmd run dist:win
```

### ヘッドレスCLI（`edit_project.v1`）

```powershell
npm.cmd run build
node scripts/video-editor.mjs validate path/to/edit_project.json
node scripts/video-editor.mjs probe path/to/edit_project.json
node scripts/video-editor.mjs plan path/to/edit_project.json
node scripts/video-editor.mjs render path/to/edit_project.json -o path/to/output.mp4
```

## GPU / エンコーダ対応方針

| OS / GPU | H.264候補 | 動作方針 |
|---|---|---|
| Windows + NVIDIA | `h264_nvenc` | 実probe成功時に使用 |
| Windows + Intel | `h264_qsv` | 実probe成功時に使用 |
| Windows + AMD | `h264_amf` | 実probe成功時に使用 |
| macOS | `h264_videotoolbox` | macOS build上で実probe |
| Linux | NVENC / QSV / AMF / VAAPI | 対応driver/deviceを実probe |
| GPUなし／失敗 | `libx264` | 自動的にCPUで再試行 |

## ドキュメント構成

- [利用者ガイド](./docs/USER_GUIDE.md)
- [機能仕様書](./docs/SPECIFICATION.md)
- [UI仕様](./docs/UI_SPEC.md)
- [アーキテクチャ](./docs/ARCHITECTURE.md)
- [エンコード実装](./docs/ENCODING.md)
- [自動字幕ワーカー契約](./docs/AUTO_CAPTION_WORKER_CONTRACT.md)
- [変更履歴](./CHANGELOG.md)

## ライセンスと注意

アプリケーションコードは MIT License です。同梱 FFmpeg バイナリのライセンス条件については [NOTICE.md](./NOTICE.md) を参照してください。
