# Phase 5 Japanese Edit Boundary / Timing Readiness

日付: 2026-08-15  
対象: Stage 5 readiness gate  
判定対象: `video_editor` の字幕編集単位とタイミング境界

## 判定

```text
EDIT BOUNDARY PRACTICAL: YES
FINE ALIGNMENT REQUIRED BEFORE HUMAN REVIEW: NO
```

実用分類は **B: 多少ズレるが manual correction 可能** とする。`estimated`境界は音響的な正解ではないが、境界の可視化・選択・分割・移動・結合・Undo/Redoが同じProject Modelとshared operationを使うため、人手で補正できる状態にある。

## 病理的日本語fixture

raw wordとして次を使用した。

```text
皆さんこんばんはアルマジロウです
source: 1,000,000–5,000,000 us
```

`Intl.Segmenter('ja', { granularity: 'word' })`によるderived edit unitは次の4件になった。

| unit | 時刻(us) | provenance | parent |
| --- | ---: | --- | --- |
| 皆さん | 1,000,000–1,750,000 | estimated | source-word:pathological-ja |
| こんばんは | 1,750,000–3,000,000 | estimated | source-word:pathological-ja |
| アルマジロウ | 3,000,000–4,500,000 | estimated | source-word:pathological-ja |
| です | 4,500,000–5,000,000 | estimated | source-word:pathological-ja |

確認した不変条件:

- edit unitの連結文字列は元captionと完全一致する。
- 全unitが同じparent raw word identityを保持する。
- 時刻は単調でclip範囲内にある。
- raw word途中のsplitでは、子captionへraw wordを二重所有させず、`words`を省略する。
- merge後もderived unitのparent identityと文字列を保持する。
- snap、Razor、ownership boundary dragは同じderived boundaryを参照する。

## 編集操作の確認範囲

専用fixture回帰と既存shared/store/renderer回帰で以下を確認した。

- 内部edit unit境界でのRazor split
- split後のparent identity、raw-word ownership安全性
- mergeによる文字列・edit unit復元
- 隣接字幕間のownership移動と境界時刻更新
- derived boundaryへのMagnet snap
- Altによるsnap bypass / free scrub
- Undo/Redoの一履歴操作
- invalid input、collision、text mismatch、words-noneのatomic rejection

`tests/shared/stage5-japanese-boundary-gate.test.ts`が病理的日本語fixtureを、既存の`subtitle-edit-units`、`subtitle-editing`、`subtitle-snap`、renderer/store回帰が周辺操作を検証する。

## Timing limitation

現在のfaster-whisper raw wordには、raw word内部の文字・音響token alignmentがない。したがって上記の比例配分は編集候補であり、acoustic truth、人手正解、品質評価の正本ではない。workerも`NO_FINE_ACOUSTIC_ALIGNMENT`をdiagnosticsへ出し、raw word truthを変更しない。

この制約は「自動境界が常に発話の瞬間を正確に切る」ことを保証しない。一方、現在の編集UIはその境界を人手で移動・split・mergeでき、推定値と音響truthを混同しないため、Human Review開始前のblocking条件とは判定しない。

## QA limitation

このStageで新たな実音声の長時間レビューを行ったとは扱わない。current-source Electronの可視GUI受入（derived units、Razor、ownership drag、merge、Undo/Redo等）は既存の`PHASE_3_5A_5_VISIBLE_GUI_ACCEPTANCE.md`にPASSとして記録されており、今回の変更ではその操作実装を変更していない。今回追加した判定は、その既存受入記録と自動回帰、Project Modelのprovenance監査に基づく。

fine alignment backendや新しいheavy dependencyは追加していない。将来必要になった場合はraw truthと分離したoptional derived provenanceとして、health check、fallback、テスト、ドキュメントを伴って導入する。

