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
  → source→timeline mapping付き一括subtitle apply
  → 新規subtitle track + SubtitleEditUnit
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

正式worker outputは`spectra.auto-caption.result.v1`を持つ一時JSONで、pathやcredentialを含まない。video_editorはschema、source range、text、word ownership、integer microseconds、sizeを検証してから適用する。caption textとowned raw word textの連結が一致する場合だけ`SubtitleWord`/`SubtitleEditUnit`へattachする。明示的な`textStatus: "display_normalized"`では、字幕表示ポリシーで除去された句読点だけを差分として許可し、raw word本文・時刻は変更しない。wordの`startUs === endUs`は点イベントとして有効だが、逆順や範囲外は拒否する。不一致時は偽のword truthを作らず字幕本文だけを適用する。worker caption IDとjob IDは生成clipのlineage metadataとして保持する。

## Stage 4 UI / atomic apply

「自動字幕」は選択clip名、言語（日本語／自動判定）、最大文字数、区切り（高品質／ルール）をdialogで受け取り、音声準備・文字起こし・字幕区切り・字幕配置をtyped progressで表示する。成功結果を全件検証した後、既存字幕を再利用せず`自動字幕`、`自動字幕 2`…の新規trackへ一度に適用する。適用はProject Modelの一つのhistory transactionなので、Ctrl+Z一回で生成track全体を戻し、Redo一回で復元できる。失敗・cancel・生成中のproject変更ではProjectFileを変更しない。

字幕生成は自動的に承認済み扱いにはしない。生成後のsubtitle clipは、既存のRazor、word-boundary split、merge、ownership drag、Undo/Redo、Inspector text edit、Review Modeで直ちに修正できる。Inspectorで本文を変更して元のword連結と一致しなくなった場合は、誤った対応付けを残さず`words`と`editUnits`を削除し、本文だけを安全に編集できる状態にする。これは編集後の推定境界を音響的真実として扱わないための明示的な挙動である。

## Acceptance boundary

- 実Whisperの正常系は生成合成メディアで受け入れる。
- unit testは外部model、network、Ollama、ユーザー素材に依存しない。
- worker未設定、モデル未導入、発話なし、実行失敗、timeout、cancel、malformed outputは通知として扱い、既存projectを変更しない。
- worker progressはtyped IPCでrendererへ転送し、cancelはjob IDをmain processへ渡す。長尺動画の処理時間とGPU memoryはモデル依存である。

旧`caption_bridge.py` / `spectra.caption_bridge.v1`は互換・参考経路として残るが、Stage 3以降の正式な「自動字幕」起動経路ではない。
- Phase 5のplanning/highlight/publish統合、TikTok/Instagram、mass Human Reviewはこのbridgeの対象外である。
