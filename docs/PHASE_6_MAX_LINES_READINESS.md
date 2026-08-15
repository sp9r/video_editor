# Phase 6 Caption Display Constraints

## 判定

```text
MAX_LINES END-TO-END: VERIFIED
```

`max_chars`と`max_lines`を別の責務として扱う。

- `max_chars`: workerのcaption境界・字幕ブロック全体の文字数上限。
- `max_lines`: video_editorの表示layoutに対する行数上限。

## 欠落していた箇所

Stage 1/2のworker contractには`maxLines`が既に存在し、clip_automation workerもcaption settingsとして受け取っていた。しかし、worker resultからProject Modelへ適用する際に`maxLines`をSubtitleClipへ保存しておらず、video_editorのshared wrapping・Preview・ASS生成もこの値を参照していなかった。このため、設定は実表示まで到達していなかった。

## 実装

- `SubtitleClip.maxLines?: number`を内部`.spectra` additive fieldとして追加した。
- `edit_project.v1`は変更していない。contract importなど値を持たない旧Projectはrender時に既定値2を使用する。
- 範囲は1〜16。Project validator、worker request、baseline settingsで既存の範囲検証を維持する。
- Auto Caption適用時に指定値をgenerated subtitle clipsへ保存する。
- canonical `SubtitleRenderSpec`に`maxLines`、実line count、layout diagnosticsを追加した。
- Preview CSSとFinal ASS/libassは同じ`wrappedText`を使用する。
- `maxLines`を超える場合、本文を削除・省略・黙って圧縮せず、`MAX_LINES_EXCEEDED` diagnosticを生成する。表示される実line countと制約値の差を明示できる。

## Authority

最終line countの受入authorityはFFmpeg/libassとする。Accurate Previewのtransparent subtitle overlayとFinal ASS frameを同じProjectFileから生成し、実画像の白glyph row bandsを比較するintegration testを追加した。通常の1 line、2 lines、日本語、font size variation、landscape、overflow、長いunbreakable textを対象にした。

overflowは「成功」と扱わず、PreviewとFinalが同じ可視line countを描画し、`MAX_LINES_EXCEEDED` diagnosticが残ることを確認する。これは本文を破壊しないための明示的なfailure/diagnostic policyである。

## Auto Caption UI

end-to-end verification完了後、Auto Caption dialogへ「最大行数」1〜16、既定2を追加した。指定値はworker request、baseline settings、generated SubtitleClip、shared Preview/ASS layoutへ到達する。

## Contract compatibility

`edit_project.v1`、`caption_project.v2.json`、`transcript_words.json`のschemaは変更していない。既存Projectの`maxLines`欠落は2行として扱う。SubtitleClipのfieldはvideo_editor内部Project Modelだけの拡張である。

