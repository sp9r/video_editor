# Subtitle Editing Foundation

## 目的

Step 3.3では、`video_editor`の通常編集画面に字幕の手動修正基盤を追加する。人手レビュー専用の別アプリや`clip_automation`内の編集機能は作らない。

データフローは次のとおり。

```text
edit_project.v1 captions
        ↓ import
video_editor Project Model (.spectra)
        ↓ Inspector / Timelineで編集
同じProject Modelを保存
        ↓
既存Preview / FFmpeg / headless render
```

`edit_project.v1`のcaption dataは通常編集の入力・出力の正本であり、`caption_review.v1`を内部Project Modelの代わりにはしない。

## 実装範囲

- Timelineの字幕クリップをクリックして選択
- Inspectorで本文、開始、終了、長さを編集
- 前後の字幕の文脈表示
- 前の字幕／次の字幕との隣接結合
- Project Modelの通常historyを使ったUndo / Redo
- 既存のPreviewとFinal renderへの即時反映
- `.spectra`保存・再読込による編集内容の保持

## 単語境界分割

SubtitleClipには、利用可能な場合だけ`.spectra`内部拡張として`words`を持たせる。各要素は`id`、`text`、字幕タイムライン上の絶対`startUs` / `endUs`を持つ。

`edit_project.v1` contract自体は拡張しない。import元に単語タイミングがなければInspectorは「単語タイミング情報なし」と表示し、単語境界分割を無効にする。単語情報がある場合は、Inspectorのトークン間の「分割」ボタンだけが分割操作を開始する。

分割時の規則:

- 左本文は左側単語の連結、右本文は右側単語の連結
- 左の開始は元の開始、左の終了は左端単語の終了
- 右の開始は右端単語の開始、右の終了は元の終了
- word IDと順序を各側へ保持
- 既存IDを再利用せず、右クリップIDは元ID・境界時刻から決定的に生成
- 本文と単語の連結結果が一致しない場合は分割しない

単語タイミング付き字幕を再生位置の任意位置で`Ctrl+K`分割することは、単語メタデータを壊すため禁止している。Inspectorの単語境界操作を使用する。

## 結合

結合対象は同一字幕トラック上の直前または直後の字幕だけである。結合後は本文を時間順に連結し、開始・終了を外側へ広げ、両方にword metadataがある場合はIDと順序を連結する。非隣接クリップは結合しない。

## 将来のレビューUIとの関係

将来の人手レビューUIは、ここで追加した字幕選択・本文編集・word boundary split・adjacent merge・通常Undo/Redoを再利用できる。レビュー評価や`caption_review.v1`固有のstatus/ratingは、この編集基盤へ混ぜない。
