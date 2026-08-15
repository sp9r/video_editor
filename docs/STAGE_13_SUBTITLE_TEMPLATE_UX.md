# Stage 13 — Subtitle Template UX

## 対象

字幕clipを選択したときのInspectorに、字幕template管理を追加した。templateの保存・validation・永続化はStage 12のmain-process serviceを利用し、PreviewとFinalは既存の共有`SubtitleStyle`／`SubtitleRenderSpec`経路を継続利用する。

## 操作

- **テンプレートとして保存**: 現在選択中字幕のstyleとmaxLinesをauthorityとして保存。保存dialogで名前、maxChars、maxLines、字幕品質を確認・変更できる
- **適用**: 選択templateのstyleとmaxLinesを現在の字幕へ適用（Project Modelの通常history対象）
- **複製**: built-inまたはuser templateをuser templateとして複製
- **名前変更**: user templateだけ変更可能
- **更新**: 現在の字幕styleで選択user templateを更新
- **削除**: user templateだけ削除可能。built-inは削除不可
- **デフォルトに設定**: built-in/user templateのどちらも設定可能。設定はuserData storeへ保存

既存の自動処理dialogにもtemplate選択は残している。Inspectorで保存したuser templateは同じcatalogから即時利用でき、次回起動後も読み込まれる。

## sample preview

Inspector内で「皆さんこんばんは / アルマジロウです」を表示する。font、size、bold/italic、letter spacing、line height、foreground、outline、shadow、background opacityを選択templateのstyleから反映する。これは別の字幕modelを作らず、Final/libassへ渡るstyleと同じ値を使う軽量なpresentation previewである。

## default persistence

storeは既存の`spectra.subtitle-template-store.v1`を維持し、`defaultTemplateId`を追加的に保存する。旧storeでこのfieldがない場合は`default`へmigrationする。削除されたuser templateがdefaultだった場合も`default`へ戻す。invalidなdefault IDは無視してcatalogを継続する。

ProjectFile、`edit_project.v1`、worker contractへtemplate pathやmachine-specific stateは保存しない。

## Timeline字幕からの保存

選択中の`SubtitleClip`が`sourceJobId`を持ち、対応する`experimental.auto-caption-baseline.v1`が読み込める場合、保存dialogのmaxCharsとsegmentationModeはそのbaselineのAuto Caption設定を初期値にする。baselineがない手動字幕や古い字幕は、現在のAuto Processing設定を初期値にする。どちらの場合も字幕本文の長さからmaxCharsを推測しない。

maxLinesはclipに保持された値を最優先し、未指定の場合だけbaseline、現在設定の順で補う。`maxWidthPercent`は選択字幕styleの値をtemplateのlayout constraintへコピーする。track内に異なるstyleが混在する場合は警告を表示し、選択中字幕のstyleを保存するauthorityとして明示する。

保存後のtemplateを別の字幕へ適用すると、SubtitleStyle全体とmaxLinesが同時に反映される。maxCharsとsegmentationModeは次回Auto Processingの生成設定として利用され、既存字幕clipへ推測値を書き戻さない。

## 検証

- userData serviceのbuilt-in/user default、unknown default、delete fallbackを回帰テスト
- Timeline字幕seed（baseline優先、current settings fallback、本文長非推測）と、template適用時のstyle/maxLines保持をshared testで検証
- `npm.cmd run check`: 50 files / 282 tests
- `npm.cmd run build`
- `npm.cmd run smoke:electron`
- `npm.cmd run smoke:accurate-preview`
