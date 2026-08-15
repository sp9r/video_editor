# Phase 7 Full-Correction Session

## Status

`FULL-CORRECTION SESSION: READY`

AI字幕を1件ずつratingする既存Review Modeとは別に、AI字幕track全体を通常のEditorで修正し、完了時にbefore/after差分を一つのexperimental artifactへ保存する入口を追加した。

## Workflow

1. 自動字幕を生成する。
2. 自動字幕trackの字幕を一つ選択し、「全文修正」を開始する。
3. split、merge、boundary move、text edit、delete、timing edit、Undo/Redoを通常どおり実行する。
4. 「修正完了」を押す。
5. AI baselineと現在のtrack全体を比較し、summaryを表示する。

開始時にProjectを変更することはなく、finish時にもsubtitle操作を追加しない。既存Project historyは通常の編集操作だけを記録する。

## Baseline and identity

`experimental.auto-caption-baseline.v1`のraw words/captionsをbefore truthとする。編集後のProject本文をbeforeへ戻して利用しない。trackの`sourceJobId`、captionの`sourceCaptionId`、raw word ID、editUnit IDを差分のidentityとして使う。

words-noneまたはtext-mismatchでもsessionは壊さず、source identityがある範囲だけeligibleとする。推定editUnit timingを新しいacoustic truthとして扱わない。

## Artifact

保存先はElectron `userData`配下の`experimental.full-correction.v1`。versioned recordの最低限の内容は次のとおり。

- sessionId / status / createdAt / finishedAt
- autoCaptionJobId
- projectId / path-free project fingerprint
- track identity
- before / after whole-track snapshots
- derived corrections
- eligibility
- statistics

media本体、absolute path、project path、credential、tokenは保存しない。active sessionはfinish前にもatomic writeするため、アプリクラッシュ後にloadして再開できる。Save/reload後も同じProject IDとtrack IDが残ればfinishできる。

## Diff categories

source identityを使った連結componentから、次を導出する。

- unchanged
- split
- merge
- boundary_move
- text_edit
- delete
- timing_edit
- mixed

summaryにはbefore/after字幕数、変更なし、分割、結合、境界移動、本文、時間、削除、複合を表示する。

## Boundary

- `edit_project.v1`、caption algorithm、clip_automation worker contractは変更しない。
- 既存のA/B/C/D Review Modeと`experimental.phase3.5b1` logは変更しない。
- Phase 8、publish、mass Human Reviewへは進まない。
