# Auto Caption Bridge

## Status

video_editorの「自動字幕」は、任意のclip_automation内部moduleをimportせず、任意設定の外部process boundaryを介して利用する。bridgeがない環境でもvideo_editorのstandalone編集、edit_project.v1読込、手動字幕、Review Modeは動作する。

## Flow

```text
選択したvideo clip
  → main processがProjectFileからasset pathを解決
  → caption_bridge.pyをshell:falseで起動
  → faster-whisper word timestamps
  → 既存clip_automation caption algorithm
  → word ownership付きtranscript JSON
  → video_editorの検証済みautomation plan
  → subtitle clips + SubtitleEditUnit
```

bridgeはrun directory、planning、highlight、publish、edit_project.v1を変更しない。生成結果は現在のProject Modelへ一つのundo可能な変更として適用される。

## Configuration

開発環境ではvideo_editorの親directoryにclip_automationがある場合、自動検出する。それ以外は次を設定する。

```powershell
$env:SPECTRA_CLIP_AUTOMATION_ROOT = 'C:\path\to\clip_automation'
$env:SPECTRA_CLIP_AUTOMATION_PYTHON = 'C:\path\to\clip_automation\.venv\Scripts\python.exe'
```

`SPECTRA_CLIP_AUTOMATION_PYTHON`未指定時はbridge rootの`.venv`を優先し、最後にOSの`python.exe` / `python3`へフォールバックする。外部実行は実行ファイルと引数配列を分離し、shell command文字列を組み立てない。

## Output boundary

bridge outputは`schema_version = spectra.caption_bridge.v1`を持つ一時JSONで、pathやcredentialを含まない。video_editorはschema、時間範囲、text、word reconstruction、word timingを検証してから適用する。wordがtextを再構成しない出力はword metadataなしとして拒否せず字幕だけを保持し、手動編集を停止させない。

字幕生成は自動的に承認済み扱いにはしない。生成後のsubtitle clipは、既存のRazor、word-boundary split、merge、ownership drag、Undo/Redo、Inspector text edit、Review Modeで直ちに修正できる。

## Acceptance boundary

- 実Whisperの正常系は生成合成メディアで受け入れる。
- unit testは外部model、network、Ollama、ユーザー素材に依存しない。
- bridge未設定、モデル未導入、発話なし、実行失敗は通知として扱い、既存projectを変更しない。
- 長尺動画は処理時間とGPU memoryがモデル依存であり、キャンセルUIと進捗イベントは今後の改善対象である。
- Phase 5のplanning/highlight/publish統合、TikTok/Instagram、mass Human Reviewはこのbridgeの対象外である。
