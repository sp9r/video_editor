# Stage 14 — Template-Aware Auto Caption

## 自動字幕への適用

Auto Processing dialogの字幕template選択は、単なる書き出し後の装飾ではない。選択IDから共有`getSubtitleTemplateSettings()`で次を同時に解決する。

- `style`
- `maxChars`
- `maxLines`

その値をworker request／caption segmentation設定と、初期`SubtitleClip`生成へ渡す。したがって最初に生成された字幕から選択templateの見た目と表示制約を持つ。

`edit_project.v1`、workerの内部実装、字幕trackの後付け一括style変更は初期caption生成の代替として使わない。

## default

Stage 13の`defaultTemplateId`を起動時に読み込み、Auto Processing dialogの初期template・文字数・行数へ反映する。templateを選択したときも3値を一緒に切り替える。user templateをdefaultに設定した後の次回自動字幕ではその値を使う。

## 既存字幕trackへの一括適用

字幕Inspectorの「字幕track全体へ適用」は、現在選択中字幕と同じsubtitle trackだけへtemplate styleを適用する。Project Modelを1回だけ更新するため、Undo 1回で一括変更全体を戻せる。

既存字幕の本文・timing・word ownershipは変更しない。`maxChars`/`maxLines`は新規生成時の制約であり、既存字幕trackへの一括適用では黙って再分割しない。既存字幕の再分割が必要な場合は、ユーザーが明示的に編集操作を行う。

## 検証

- template settings helperでstyle/maxChars/maxLinesの同時解決を回帰テスト
- user templateの初期caption適用を既存adapter testで維持
- selected subtitle trackだけの一括style適用とUndo単位を回帰テスト
- `npm.cmd run check`: 48 files / 264 tests
- `npm.cmd run build`
- `npm.cmd run smoke:electron`
- `npm.cmd run smoke:accurate-preview`

