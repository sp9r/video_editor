# Auto Caption Worker Contract v1 — Operational Boundary

## Status

これはStage 9時点で実際に接続され、生成QAメディアで受入したlocal process boundaryです。`edit_project.v1`とは別のworker contractであり、worker内部実装をvideo_editorへ公開しません。schemaの正式な将来拡張はversionを上げます。

## Direction

```text
video_editor main process
  → spectra.auto-caption.request.v1
  → clip_automation/spectra_caption_worker.py
  → spectra.auto-caption.result.v1
```

rendererは任意commandを指定できず、main processだけがworkerとmedia pathを解決します。workerがない場合でもstandalone edit_project loader、手動編集、Preview、Renderは利用できます。

## Request

必須fieldは`version`、`jobId`、`mediaPath`、`sourceStartUs`、`sourceEndUs`、`language`、`maxChars`、`segmentationMode`です。`maxLines`は1〜16のoptional settingです。時刻はsafe integer microsecondsです。対象source rangeは`sourceInUs`から`sourceInUs + durationUs`です。

`mediaPath`は実行時requestだけに存在し、ProjectFile、baseline、resultへ保存しません。

## Result

`version`、`jobId`、source range、language、provider/model、`rawWords[]`、`captions[]`、`diagnostics[]`、`fallback`を返します。raw wordはstable id、text、source absolute `startUs` / `endUs`、optional confidenceを持ちます。captionはid、text、sourceWordIds、source absolute time、textStatus、provenanceを持ちます。

resultとbaselineにはabsolute media path、project path、credential、tokenを含めません。video_editor main processがversion、size、job、range、ownership、禁止fieldをruntime validationします。

## Mapping

```text
timelineUs = clip.startUs + (sourceUs - clip.sourceInUs)
```

captionとraw wordへ同じmappingを適用します。workerはtimeline timeを生成しません。

## Processing and fallback

workerはselected rangeだけをFFmpegでtemporary WAV化し、`faster-whisper`の`word_timestamps=True`を実行します。字幕分割は既存`caption.py`を再利用し、LLMが利用できない場合はrule fallbackをdiagnosticsへ記録します。jumpcut、planning、highlight、render、publishはworkerの責務外です。

## Truth and limitations

raw Whisper wordsは不変source truthです。日本語raw word内の`SubtitleEditUnit`はvideo_editor側で生成する編集用derived metadataであり、比例推定時刻をfine acoustic alignmentと呼びません。現在fine acoustic alignmentは未実装です。

## Persistence and privacy

生成時のbaselineは`experimental.auto-caption-baseline.v1`としてuserDataへatomic保存され、Full CorrectionやReview logとは別です。path、credential、media本体は保存しません。

## Failure

missing worker、missing model、missing media、malformed result、oversized result、nonzero exit、timeout、cancelでは、部分resultを成功扱いせずProjectを変更しません。temporary input/outputはcleanupします。
