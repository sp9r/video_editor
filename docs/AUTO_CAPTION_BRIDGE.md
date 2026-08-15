# Auto Caption Bridge / Worker

## Status

video_editorの「自動字幕」は、`spectra_caption_worker.py`とのversioned JSON process boundaryを介して利用する。video_editorはclip_automationのPython moduleをimportせず、workerがない環境でもstandalone編集、edit_project.v1読込、手動字幕、Review Modeは動作する。

## Flow

```text
選択したvideo/audio clip（1件）
  → main processがProjectFileからasset pathを解決
  → sourceInUs〜sourceInUs+durationUsのrequestを生成
  → spectra_caption_worker.pyをshell:falseで起動
  → faster-whisper word timestamps
  → 既存clip_automation caption algorithm
  → versioned result（source absolute microseconds / word ownership）
  → main processのruntime validation
  → source→timeline mapping付きautomation plan
  → subtitle clips + SubtitleEditUnit
  → userData baseline（atomic）
```

bridgeはrun directory、planning、highlight、publish、edit_project.v1を変更しない。生成結果は現在のProject Modelへ一つのundo可能な変更として適用される。

## Configuration

解決優先順位は、userDataの明示設定、環境変数、兄弟directory discoveryである。明示設定ファイルはProjectFileとは別に、userData直下の`auto-caption-worker.json`へ置く。

```json
{"workerRoot":"C:/path/to/clip_automation","pythonPath":"C:/path/to/clip_automation/.venv/Scripts/python.exe"}
```

環境変数を使う場合:

```powershell
$env:SPECTRA_AUTO_CAPTION_WORKER_ROOT = 'C:\path\to\clip_automation'
$env:SPECTRA_AUTO_CAPTION_PYTHON = 'C:\path\to\clip_automation\.venv\Scripts\python.exe'
```

設定・環境・兄弟directoryのいずれでもworker scriptとPythonを解決できない場合、healthは`available=false`を返し、local pathや内部exceptionを表示しない。外部実行は実行ファイルと引数配列を分離し、shell command文字列を組み立てない。

## Output boundary

正式worker outputは`spectra.auto-caption.result.v1`を持つ一時JSONで、pathやcredentialを含まない。video_editorはschema、source range、text、word ownership、integer microseconds、sizeを検証してから適用する。display normalizationでraw word textとcaption textが一致しない場合も、source word metadataと表示textを別フィールドとして保持する。

字幕生成は自動的に承認済み扱いにはしない。生成後のsubtitle clipは、既存のRazor、word-boundary split、merge、ownership drag、Undo/Redo、Inspector text edit、Review Modeで直ちに修正できる。

## Acceptance boundary

- 実Whisperの正常系は生成合成メディアで受け入れる。
- unit testは外部model、network、Ollama、ユーザー素材に依存しない。
- worker未設定、モデル未導入、発話なし、実行失敗、timeout、cancel、malformed outputは通知として扱い、既存projectを変更しない。
- worker progressはtyped IPCでrendererへ転送し、cancelはjob IDをmain processへ渡す。長尺動画の処理時間とGPU memoryはモデル依存である。

旧`caption_bridge.py` / `spectra.caption_bridge.v1`は互換・参考経路として残るが、Stage 3以降の正式な「自動字幕」起動経路ではない。
- Phase 5のplanning/highlight/publish統合、TikTok/Instagram、mass Human Reviewはこのbridgeの対象外である。
