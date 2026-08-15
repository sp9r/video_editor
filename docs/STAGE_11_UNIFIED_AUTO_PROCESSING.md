# Stage 11: Unified Auto Processing

## Scope

自動字幕を、字幕生成だけでなく無音カット・処理デバイス・字幕品質・字幕テンプレートを一画面で選ぶ入口へ統合した。既存の単一clip選択、worker discovery、source-time mapper、atomic Project applyは維持する。

## Dialog defaults

| 設定 | 初期値 | contract value |
| --- | --- | --- |
| 自動字幕 | ON | UI-only toggle |
| 無音カット | 自然 | `natural` |
| 処理デバイス | 自動（推奨） | `auto` |
| 言語 | 日本語 | `ja` |
| 字幕品質 | 高品質 | `auto` |
| 字幕テンプレート | 標準 | `default` |
| 最大文字数 | 32 | `maxChars: 32` |
| 最大行数 | 2 | `maxLines: 2` |

自動字幕をOFFにした場合、他の自動処理はまだ提供していないため実行ボタンを無効にする。設定だけでProjectを変更することはない。

## Contract boundary

`AutoCaptionSettings` / `spectra.auto-caption.request.v1`へ、後方互換なoptional fieldとして次を追加した。

- `silenceCut`: `off` / `natural` / `strong`
- `accelerationMode`: `auto` / `gpu` / `cpu`
- `subtitleTemplate`: `default` / `high-contrast` / `minimal`

旧request・baselineにfieldがない場合は従来どおり扱い、main serviceの実行時defaultは `natural` / `auto` / `default` とする。templateはmachine-specific backendではなく、生成SubtitleClipのstyleへ適用するためProjectFileにtemplate IDを固定保存しない。

## Processing and atomic apply

```text
selected clip
  ├─ bounded source audio preparation
  ├─ Whisper transcription + signal-authoritative silence analysis (parallel worker)
  ├─ source-time keep map / shared mapper
  ├─ caption segmentation result validation
  ├─ template style application
  └─ one Project/history apply (silence cut + new subtitle track)
```

`silenceCut=off`ではsilence analysis artifactを生成せず、字幕だけを適用する。`natural` / `strong`では既存のsignal-based analysisを使い、raw Whisper wordはspeech protectionとして保持する。caption/word/edit-unit timingはStage 10の同一source-time mapperで変換する。

workerへ渡すのはversion付きJSONとargvだけで、video_editorはclip_automationのPython moduleをimportしない。`accelerationMode=gpu`はworkerの既存GPU policyへ渡り、GPU不可時にCPUへ黙ってfallbackしない。`auto`だけが既存policyに従ってfallbackできる。

## Validation

- video_editor: `npm.cmd run check` — 46 files / 255 tests PASS
- clip_automation: full unittest 291 tests / compileall PASS
- edit_project.v1 schemaは変更なし
- existing subtitle tracksは上書きせず、新規trackへ適用

## Deferred

auto-caption以外のsilence-only processing、machine-specific settingsの永続化、追加templateの編集UI、Stage 12以降のplanning/highlight/publishingは本Stageの範囲外。
