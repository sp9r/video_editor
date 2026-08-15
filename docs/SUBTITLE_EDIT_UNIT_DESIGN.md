# Subtitle Edit Unit Design

## Purpose

`transcript_words.json`と`edit_project.v1`のword metadataは、source identityと既存時刻を保持するための情報である。動画編集UIの最小編集単位とは限らない。特に日本語Whisper outputは、複数の自然な語を一つのraw wordへまとめることがある。

## Raw flow

`clip_automation`の現行経路は次のとおり。

1. `transcribe.py`がfaster-whisperの`word_timestamps`を読み、`start`、`end`、`word`、`probability`を保存する。
2. `timeline_project.py`が入力順のstable `word_id`を付け、`transcript_words.json`を不変source/timeline artifactとして生成する。
3. `caption.py`と`caption_project.v2.json`がcaptionの範囲と表示文字を保持する。
4. `edit_project_adapter.py`が連続source wordを`source-word:<id>`として`edit_project.v1`へ写像する。
5. `video_editor` standalone loaderがcontract wordsを`SubtitleWord`へ変換する。

現状、raw word内の文字・音響token alignmentは生成されていない。`estimated`はこの欠落を埋める編集用の近似であり、字幕品質評価や音響truthへ逆利用しない。

## Internal model

```ts
interface SubtitleEditUnit {
  id: string
  text: string
  parentSourceWordId: string
  startUs: number
  endUs: number
  timingProvenance: 'source' | 'estimated' | 'point'
}
```

- `id`は`${parentSourceWordId}:edit:${index}`で決定的。
- `text`のconcatは元caption textと一致する。
- `parentSourceWordId`はraw sourceへのtraceability。
- raw word全体は`source`、語塊内比例配分は`estimated`。
- zero-duration/point sourceは全unitを`point`とし、正のdurationを発明しない。
- 時刻は単調非減少、clip範囲内。低精度で同時刻になったunitは有効な時間分割候補にしない。

日本語の境界はフレーズ固有表ではなく`Intl.Segmenter('ja', { granularity: 'word' })`を用いる。空白・句読点は可能な限り直前のunitへ結合し、concat fidelityを守る。

## Compatibility and ownership

- `edit_project.v1`のschema、`captions[].words` semantics、`transcript_words.json`は変更しない。
- 旧`.spectra`に`editUnits`が無ければraw wordsをatomicとして従来境界を維持する。
- standalone contract importでは内部`editUnits`を生成する。
- raw word途中でsplitした子captionは、raw wordを誤って二重所有しないため子`words`を省略する。編集単位のsource ownershipは`parentSourceWordId`で保持する。
- merge、move、split、undo/redo、save/reloadはedit unitsを保持する。

## Shared editing behavior

同じedit-unit boundary sourceを、Inspector split、Razor ghost/click、隣接caption ownership drag、playhead snappingで使用する。Snapは字幕選択中またはReview Mode中だけ有効で、Altは連続scrubのbypassとする。merge controlはboundary dragと別UI操作であり、storeの既存merge operationを一履歴 transactionとして呼び出す。

## Known limitation

現時点でfine acoustic alignmentは未実装である。`estimated` boundaryは編集候補であり、Whisperの音響的語境界・人手正解・品質評価の正本ではない。将来alignmentを追加する場合も、`transcript_words.json`を上書きせず、新しいprovenance/schemaとして検証する。
