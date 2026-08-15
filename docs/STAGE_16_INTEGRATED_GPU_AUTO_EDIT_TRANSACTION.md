# Stage 16 Integrated GPU Auto Edit Transaction

## Status

`INTEGRATED GPU AUTO EDIT TRANSACTION: CLOSED`

Stage 16では、選択した単一media clipに対するGPU/worker処理、signal-based silence cut、source→timeline mapping、字幕template適用、auto-caption baseline保存、Project適用を、一つのrenderer操作として検証した。Stage 17、planning、highlight、publishing、mass Human Reviewは開始していない。

## 正式な処理順序

```text
selected clip
  -> worker/GPU health
  -> bounded source preparation
  -> Whisper transcription || signal silence analysis
  -> caption segmentation
  -> validated keep ranges
  -> source-time -> compacted timeline mapping
  -> linked A/V media segmentation
  -> subtitle generation
  -> selected template (style / maxLines)
  -> experimental.auto-caption-baseline.v1
  -> one Project history apply
```

`clip_automation`のworkerはversion付きJSON境界の外へ出ず、video_editorはworkerのPython moduleをimportしない。ProjectFileへ変更を反映するのは、worker result、silence artifact、source range、word ownership、Project fingerprintを検証した後の最後の`applyProject()`だけである。

## Atomicity and cancellation

- worker health failure、malformed result、source range不一致、unsafe ripple、raw wordとremoved rangeの重複、template／mapping検証失敗ではProjectを変更しない。
- cancelはworkerとsilence analysisへ共通Abortを伝え、terminal stateが`CANCELLED`になった場合もProjectを変更しない。
- 既存subtitle trackを再利用せず、成功時だけ新しい`自動字幕` trackを追加する。
- silence cutとlinked A/V segmentation、字幕track追加は同じhistory entryへ合成される。

## Undo / Redo semantics

成功した自動処理1回は1つのcoherent Project operationである。

- Ctrl+Zを1回実行すると、silence cut前のlinked A/V clip、既存字幕、生成字幕trackを含む処理前Projectへ戻る。
- Redoを1回実行すると、keep rangeで圧縮されたmedia clipsと選択template付き字幕trackを同じ状態へ復元する。
- 途中失敗・キャンセルにはhistory entryを作らないため、Undoで失敗した処理を戻す必要はない。

## Baseline and Full Correction

worker成功時にmain processが`experimental.auto-caption-baseline.v1`をuserDataへatomic保存する。raw words、initial captions、provider/model、settings、diagnostics、source clip identityを保持し、path・credential・media本体は保存しない。

Full Correction開始時のbeforeは、自動編集完了後のgenerated subtitle trackを基準にする。worker baselineから本文とsource identityを再構成しつつ、generated clipのtimeline／word timingを採用するため、silence cutで圧縮された時刻を旧source→timeline式へ戻さない。以後のsplit、merge、boundary move、text edit、deleteは通常のProject historyで行い、完了時にwhole-track diffを保存する。

## 検証範囲

renderer regressionでは、次を固定した。

- selected user templateのstyle/maxLinesが生成直後に適用される。
- 成功時のhistory entryが1件で、Undo/RedoがProject全体を原子復元する。
- worker失敗時とstarted jobのcancel時にProjectとhistoryが不変である。
- Full Correction開始へ渡されるProjectが自動編集完了後のProjectである。
- silence compaction後のFull Correction beforeがgenerated clipのcompressed timelineを保持する。

既存のworker、caption algorithm、edit_project.v1、Preview／Final render、GPU backend自体はこのStageで再実装していない。GPU実機のruntime性能、GPU encodeの可否、fine acoustic alignmentは別の既存checkpoint／backlogで扱う。
