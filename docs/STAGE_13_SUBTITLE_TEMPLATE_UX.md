# Stage 13 — Subtitle Template UX

## 対象

字幕clipを選択したときのInspectorに、字幕template管理を追加した。templateの保存・validation・永続化はStage 12のmain-process serviceを利用し、PreviewとFinalは既存の共有`SubtitleStyle`／`SubtitleRenderSpec`経路を継続利用する。

## 操作

- **テンプレートとして保存**: 現在選択中字幕のstyleを名前付きuser templateとして保存
- **適用**: 選択templateのstyleを現在の字幕へ適用（Project Modelの通常history対象）
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

## 検証

- userData serviceのbuilt-in/user default、unknown default、delete fallbackを回帰テスト
- `npm.cmd run check`: 48 files / 262 tests
- `npm.cmd run build`
- `npm.cmd run smoke:electron`
- `npm.cmd run smoke:accurate-preview`

