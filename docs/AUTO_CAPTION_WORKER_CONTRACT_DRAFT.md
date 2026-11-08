# Auto Caption Worker Contract Draft

Stage 1のlocal process boundary草案。永久schemaではなく、実workerのrange処理・cancel/progress・baseline保存の受入後に正式版へ昇格する。

## Audit conclusion

`src/main/ai/provider.ts`、registry、mock provider、transcription capabilityは汎用AI拡張基盤である。一方、`src/main/ai/external-caption.ts`と`caption_bridge.py`の現在経路は互換用の非公式bridgeで、全sourceを対象にした`transcript`出力を一時JSONで受け取るだけである。現時点ではrequestの`jobId`・source range、正式result version、fallback/diagnostics、immutable baselineを持たない。

`docs/AI_EXTENSION_GUIDE.md`にあるWhisper providerは実装コードではなく、provider境界を説明する例である。実Whisper処理は今回の境界の先にあるclip_automation workerだけが担当する。

## Boundary

```text
video_editor
  → versioned JSON request/result
  → clip_automation worker
```

video_editorはPython moduleや`data/runs`を直接参照しない。字幕境界アルゴリズムをTypeScriptへコピーしない。Project Model、history、SubtitleWord、SubtitleEditUnitはvideo_editor内部の責務として保持し、workerには渡さない。

正式なdraft本文、field定義、baseline設計は、兄弟repo
`C:\Storage\30_Software\90_Self_Made\Apps\clip_automation\docs\contracts\auto_caption_worker_v1_draft.md`
に対応する。ここではvideo_editor側の検証・変換責務を固定する。

## Request / result obligations

Request versionは`spectra.auto-caption.request.v1`。必須は`version`、`jobId`、workerが読む`mediaPath`、`sourceStartUs`、`sourceEndUs`、`language`、`maxChars`、`segmentationMode`。`maxLines`は既存caption settingsが対応するため任意で渡せる。

Result versionは`spectra.auto-caption.result.v1`。`jobId`、source range、language、provider/model、`rawWords[]`、`captions[]`、`diagnostics[]`、fallback情報を持つ。時刻はすべて整数microseconds。resultとbaselineにはabsolute media path、project path、credentials、tokenを保存しない。

`rawWords[].id`はsource/transcript identity、`captions[].sourceWordIds`はcaption ownershipである。Project Modelへ変換するときは既存の`SubtitleWord`と`SubtitleEditUnit`の意味を混同せず、編集単位を新しいworker schemaの正本にしない。

## Range mapping

workerの対象範囲は選択clipの
`sourceInUs`〜`sourceInUs + durationUs`。worker resultはsource media絶対時刻のまま返す。video_editor側のmappingは次で固定する。

```text
timelineWordUs = clip.startUs + (sourceWordUs - clip.sourceInUs)
```

つまりworkerはtimeline/sequence時刻を再構築しない。`src/shared/auto-caption-contract.ts`のmapping helperが範囲外を拒否する。

## Baseline

生成時の不変source truthは`experimental.auto-caption-baseline.v1`として、将来app userData配下へatomic保存する。review logやcurrent ProjectFileへ混ぜず、fingerprint、source clip identity、mapping formula、rawWords、initial captions、settings、provider/model、diagnostics/fallbackだけを持つ。Stage 1では型とpath-free validatorまでを追加し、永続化は次段階とする。

## Stage 3 integration

`src/main/ai/auto-caption-service.ts`が正式workerのmain-process境界である。旧`caption_bridge.py`は
互換テスト・参考実装として残るが、通常の「自動字幕」runtime pathでは使用しない。

- worker rootは、userData配下の`auto-caption-worker.json`にある明示設定、環境変数、兄弟directory discoveryの順に解決する。Pythonも同じ優先順で解決し、absolute pathをsource codeへ埋め込まない。未発見時はpathを表示せず利用不可を返す。
- rendererはworker commandを渡さない。main processがselected clipを1件に制限し、video/audio、online、audio stream、absolute media path、source rangeを検証してrequestを生成する。
- worker processは`ProcessExecutor`経由で`shell:false`、argv配列、temporary request/resultを使う。stdout JSONL progress、result size、version、jobId、range、ownership、forbidden fieldをruntime validationする。stderr・exceptionのcredential/local pathはrendererへ返さない。
- source absolute microsecondsは`mapAutoCaptionSourceTimeToTimelineUs`でcaptionとowned wordsへ同じ式を適用する。ProjectFileへworker pathは保存しない。
- 成功したresultだけを`userData/experimental.auto-caption-baseline.v1/*.json`へatomic保存する。baselineはproject/media fingerprint、clip identity、mapping、rawWords、initial captions、settings、diagnostics/fallbackだけを保持し、media/project pathを保持しない。malformed baselineは他のrecordを止めずにskipする。
- typed IPCは`autoCaptionHealth`、`startAutoCaption`、`onAutoCaptionProgress`、`cancelAutoCaption`、`loadAutoCaptionBaselines`だけを公開する。自動字幕生成は完了progressのresultを検証済みProject Model planへ変換し、通常のUndo可能な適用経路へ渡す。

## Stage 1 non-goals

- Stage 3で実装済み: 自動字幕UIからのrequest接続、Project Modelへの適用
- faster-whisperのrange decodeやcaption algorithmの変更
- existing `spectra.caption_bridge.v1`のcutover
- history/review logへのbaseline混入
- clip_automationの内部module import
