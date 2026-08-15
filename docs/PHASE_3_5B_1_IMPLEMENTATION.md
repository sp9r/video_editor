# Phase 3.5B-1 Human Review MVP Implementation

## Status

Phase 3.5B-1 の最小実装を完了した。これは字幕品質改善用の実験的なGUI review sessionであり、`edit_project.v1`、`.spectra` ProjectFile、`caption_review.v1`、字幕生成アルゴリズムを変更しない。

## 実装範囲

- Review Mode の明示的なON/OFF。
- subtitle trackをtimeline順にreview targetとして列挙し、targetと前後captionを表示。
- review開始時にtarget/neighborhoodのbaseline snapshotをmemoryへ固定。
- Good / Acceptable / Corrected / Skip の明示評価。
- Skipはsession-localに次targetへ進み、ratingを確定したrecordとして保存する。
- baselineと評価時点のProject Modelから、`boundary_split`、`boundary_merge`、`boundary_move`、`text_edit`、`delete`、`timing_edit`、`mixed`、`none`をbest-effortで導出。
- word IDが使える場合だけboundary learningをeligibleとし、words-noneまたはtext mismatchはreviewを継続しつつ学習対象から分離。
- review stateはrenderer storeに保持し、ProjectFileへ書き込まない。
- local experimental logは`app.getPath('userData')/review/experimental.phase3.5b1.json`へ保存し、同一session・targetの最新decisionをupsertする。
- provenance fingerprintと既存logの再保存時に`path`、`relativePath`、`projectPath`を除去し、raw local pathをreview logへ残さない。
- rendererからmain processのtyped IPCを通してload/upsertする。media pathはlogへ保存しない。

## UI / 操作

- Review Mode OFFでは通常editorのshortcutと操作を維持する。
- Review Mode ONではpanelから評価・前後移動を行い、`A/B/C/D`は入力欄・contenteditableにフォーカスがない場合だけ候補として扱う。
- ratingは編集操作と独立しており、編集しただけではCorrectedにならない。
- project変更後もbaselineはUndo historyに追従せず、decision時の最終状態との差分だけを比較する。

## Persistence / schema境界

保存対象は`experimental.phase3.5b1` version、session、target identity、baseline、final snapshot、rating、correction summary、learning eligibility、最小限のproject/media provenanceに限定する。malformed logは空状態として安全に扱う。ProjectFileの再保存・再読込とreview logは独立している。

## 検証

- `npm.cmd run check`: 34 test files / 193 tests PASS。
- `npm.cmd run build`: PASS。
- `npm.cmd run smoke:electron`: PASS。`didFinishLoad=true`、root child 1、`.app-shell`、preload API、playhead、console errors 0。
- QA用16字幕projectをElectron GUIで開き、Review ModeをONにして10件を評価。Good 3、Acceptable 3、Corrected 3、Skip 1を確認した。Correctedの1件はInspectorで本文を実際に編集してから評価し、review logへ10 recordが保存された。
- QA projectの`.spectra`ファイルはreview fieldを持たず、review logはuserData配下に分離されている。

## 未実施 / 次段階

- 10件以上の全件評価は完了した。split/merge/boundary moveのGUI操作を含む長時間human acceptanceは別QAで継続する。
- correction artifactの正式schema、複数reviewerのmerge policy、学習datasetへのexport policyは未確定。
- Phase 3.5B-2以降の正式なcaption correction pipelineは未着手。

## Non-goals

`clip_automation`、caption algorithm、`caption_review.v1`、`edit_project.v1`、Project Model schema、render pipeline、Phase 4/5の機能はこの実装の対象外である。
