# Phase 3.5B Human Review / Correction Capture Design Draft

状態: **DRAFT / NOT CONTRACT / NOT IMPLEMENTED**  
目的: Step 3.5Aのtimeline字幕編集を、人手レビュー用の品質データへ安全に接続するための設計検討。  
この文書は`edit_project.v1`、`caption_review.v1`、Project Model、既存caption algorithmを変更しない。

## 1. 現在の資産と責務

### video_editor Project Model

- `ProjectFile`はsequence、media、tracksを持つ内部`.spectra` modelである。
- `SubtitleClip`はclip id、本文、timeline/source時刻、style、任意の`words[]`を持つ。
- `SubtitleWord`はword id、text、`startUs`、`endUs`を持つ。bridge由来のidは`source-word:<word_id>`である。
- splitは元clip idを左側へ保持し、右側へ決定的な派生idを与える。merge、ownership move、deleteも通常のProject Model編集として適用される。

### 編集操作と履歴

- split、merge、boundary move、delete、dragはshared domain operationを通り、Storeのsnapshot historyへ1操作として入る。
- Inspectorの連続変更はtransaction境界でまとめられる。
- 現状のhistoryはUndo/Redo用のProject snapshotであり、人手レビュー向けの永続的なoperation event logではない。
- 従って、レビューartifactはhistory内部へ埋め込まず、レビュー単位とbefore/after snapshotを別途保持する必要がある。

### clip_automation側

- `caption_project.v2.json` / `transcript_words.json`は字幕・transcriptモデルの正本である。
- `caption_review.v1`は既存のbenchmark、人手rating、boundary評価向けartifactであり、video_editor Project Modelの代替ではない。

## 2. traceabilityの不足

現在不足しているのは、単なる最終字幕ではなく「何を見て、何をどう直したか」の追跡である。

- review targetが元captionか、split後のleft/rightかを識別する安定したreview identity。
- review開始時のtargetと前後captionのbaseline snapshot。
- project path、project fingerprint、source media fingerprint、sequence timebaseのprovenance。
- split/merge/move/delete/text editの操作種別と、操作前後の差分。
- words-none、text mismatch、metadata不備を品質学習へ含めるか除外するかの明示。
- 同じcaptionを再レビューした時のsession、reviewer、decision時刻。

## 3. 推奨review unit

推奨は**caption neighborhood unit**である。target captionだけでなく、同一subtitle track上の直前・直後captionを含める。

理由:

- boundary move、merge、collision判定は隣接captionとの関係で決まる。
- target単体では、空白・gap・前後のword ownershipの妥当性を評価できない。
- neighborhoodをartifactへ保存しておけば、後からProject Modelを再構築せずに人間の判断根拠を確認できる。

review unitのidentityは、元caption idに加えて、同じreview session内の派生lineageを持つ。splitで右側が新idになっても、`parent_caption_id`と`derived_caption_ids`で追跡する。contractのclip idを変更する提案ではない。

## 4. baselineとbefore/after戦略

review対象へ入った時点で、次のimmutable baselineをcapturedする。

- targetと前後captionのcaption id、text、timeline/source time。
- wordsの有無、word id、text、start/end、本文一致判定。
- style fingerprintとproject fingerprint。
- track id、sequence settings、source media id/fingerprint。

decision時には同じneighborhoodを現在Project Modelから再取得し、baselineとの差分を導出する。

### 比較案

| 案 | 内容 | 評価 |
|---|---|---|
| A | baselineと最終状態のsnapshotだけ保存 | MVP向き。差分分類は後処理できる |
| B | snapshot + UI操作eventを逐次保存 | traceabilityは高いがUndo/Redoや中断で複雑になる |
| C | snapshot + 最終状態 + derived correction summary | 推奨。event logを正本にせず、監査可能な差分を残せる |

推奨はC。試行錯誤中の操作を学習データへ誤って含めないため、review decision時に最終状態からcorrection summaryを作る。

## 5. rating semantics

既存の`caption_review.v1`のrating語彙との対応を維持し、表示名だけを日本語UIへ翻訳する。

- **Good**: 人間が自然・適切であると積極的に確認した。positive quality evidence。
- **Acceptable**: 明確な修正は不要だが、積極的なgold positiveとは扱わない。学習時の扱いは別途決定する。
- **Corrected**: 人間が編集操作または本文編集を行い、修正後状態を確認した。修正前がbadだったというratingとは自動同一視しない。
- **Skip**: 今回は判断しなかった。ratingを保存せず、session内だけeligibleから除外する。次回sessionでは再レビュー可能。

評価を確定するのはユーザーが明示的にratingを選択した時だけとする。操作しただけではCorrectedを自動保存しない。

## 6. operation-derived correction

ユーザーへ「どのboundaryを直したか」を別入力させず、baselineとdecision時点の差分から導出する。

- `boundary_split`: 1 captionが複数派生captionへ分かれた。
- `boundary_merge`: 近接captionが1 captionへ統合された。
- `boundary_move`: caption境界を跨いでword ownershipが移動した。
- `timing_edit`: start、duration、source timingのみが変わった。
- `text_edit`: 本文が変わった。word metadataとの対応が再評価対象。
- `delete`: targetまたは派生captionが削除された。
- `mixed`: 複数種別が同一review decisionまでに起きた。

同じ操作をUndoした場合は最終状態に差分がなければcorrectionなしとする。試行したが採用しなかった操作をtraining correctionへ混ぜない。

## 7. words-none / text mismatch policy

- words-none: 表示・通常編集・Good/Acceptable/Skipは許可する。ただしword boundary qualityの学習・boundary評価positive/negative集合からは除外する。
- text mismatch: 本文品質のreview対象にはできるが、word boundary correctionの教師データへは入れない。明示的なtext/word alignment policyが決まるまで、text correction候補として別分類にする。
- word id欠落、重複、逆順、zero-durationなどのmetadata不備は、reviewerのratingとは別にdiagnosticとして保存する。自動的にBadへ変換しない。

## 8. Undo / Redoとの関係

review開始時にbaseline snapshotを固定し、通常のUndo/RedoはProject Modelの操作としてそのまま利用する。

- Undo/Redoの各stepをレビューartifactへ逐次記録しない。
- decision前のUndoでbaselineへ戻った場合、correctionは空になる。
- decision後にさらに編集したい場合は、新しいreview unit/sessionを開始する。
- artifactのbefore/afterは、decision確定直前の最終状態を指す。

## 9. caption_review.v1の再利用

再利用候補:

- ratingの語彙とstatusの考え方。
- benchmark sample identity、境界判定、preferred systemなどの評価概念。
- strict-clean / excludedの集合を壊さない既存review運用。

不足:

- video_editorのProjectFile identity、project fingerprint、source provenance。
- target前後のneighborhood。
- split後のcaption lineage。
- before/after Project Model snapshotとoperation-derived correction。
- GUI session、Skipのsession-local semantics、Undo/Redoとの関係。

結論: `caption_review.v1`を変更・拡張してGUI correction artifactの正本にはしない。

## 10. artifact案

### 案1: `caption_review.v1` additive extension

既存artifactへoptional fieldを追加する。既存reader互換を保ちやすいが、benchmark評価artifactとEditor correction logの責務が混ざり、version・privacy・provenanceの境界が曖昧になる。

### 案2: separate correction artifact

`caption_correction`相当の別artifactを作り、caption_reviewは既存の評価artifactとして維持する。責務、retention、session、GUI operationの差を明確にできる。

推奨は**案2**。ただし本Phaseではschemaを作らず、正式contract化はPhase 3.5B-1の実装後に別reviewする。

## 11. privacy / retention

- video/audio本体はartifactへコピーしない。
- 保存対象はcaption text、word timing、Project/Source fingerprint、必要なpath basename、reviewer/session、before/after metadataに限定する。
- raw local path、token、credential、外部API情報をartifactやログへ出さない。
- real transcriptはGitへ追加しない。local ignored outputまたはユーザー指定のprivate storageへ置く。
- export/share時はtextとpath、project idのredactionを可能にする。
- retentionはreview session、project fingerprint、artifact status単位で削除可能にする。

## 12. MVP: Phase 3.5B-1

1. GUIからreview sessionを開始し、caption neighborhoodのbaselineをmemoryへ固定する。
2. 通常の字幕編集操作を再利用する。
3. Good / Acceptable / Corrected / Skipを明示入力できる。
4. Skipはratingを保存せず、session-local skipped idだけを保持する。
5. decision時にbaseline/current差分から correction summary を導出する。
6. local ignored append-only artifactへ保存する。
7. session再開時に未確定Skipを再びeligibleにする。
8. words-none / text mismatch / metadata diagnosticを学習集合から分離する。

このMVPではcaption algorithm、edit_project.v1、render、Project Modelのschema、既存`caption_review.v1`を変更しない。

## 13. 未決定事項

- Acceptableを学習positiveから除外するか、弱いpositiveとして使うか。
- text correctionをboundary datasetと別datasetへ分ける単位。
- split/merge後のlineageをどの粒度で保持するか。
- source caption idが存在しないlegacy projectのidentity fallback。
- 同じprojectを複数reviewerがレビューした場合のmerge/conflict policy。
- baseline snapshotを全文保存するか、hash + minimal neighborhoodで足りるか。
- review decisionの確定操作と、Skip/quit/session resumeのUI。
- キーボードショートカットと編集ショートカットの衝突回避。
- correction artifactの正式schema version、保存先、export API。

## 14. Phase 3.5B-1開始条件

- 本草案を設計承認する。
- correction artifactを`caption_review.v1`から分離する方針を確認する。
- words-none / text mismatchの除外規則を決定する。
- review unit、baseline、decision、Skipのresume semanticsを固定する。
- formal projectとreal transcriptを分けたfixtureを用意する。

本Phaseの設計は本草案を基礎に実装へ反映した。実装状況と検証結果は [`docs/PHASE_3_5B_1_IMPLEMENTATION.md`](PHASE_3_5B_1_IMPLEMENTATION.md) に記録する。正式なcorrection artifact schemaとexport policyは引き続き未確定である。

## 15. keyboard workflow案

大量レビューでは、Review Modeが明示的に有効な時だけ、次の仮案を検討する。

- `A`: Good
- `B`: Acceptable
- `C`: Corrected
- `D`: Skip
- `Esc`または別の明示操作: 中断してsession stateを保存

ただし`C`は既存のRazor/編集ショートカットと衝突し得るため、通常編集時のglobal shortcutにはしない。Review Mode toggle、focus中のtext input、既存`V`/`C`操作との優先順位はPhase 3.5B-1でE2E確認してから固定する。

## 16. audio / context方針

CLIレビューで不足しやすい音声、前後字幕、映像contextは、独立review appへ複製せず、通常のvideo_editor playback、timeline、neighborhood表示をそのまま使って補う。Review modeはProject Modelと通常のplayhead/Accurate Previewを共有し、評価だけを別session stateとして重ねる。これにより、レビュー用の別timeline解釈や別render経路を作らない。
