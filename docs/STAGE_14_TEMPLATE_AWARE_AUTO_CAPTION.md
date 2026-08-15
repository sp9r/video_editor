# Stage 14 — Template-Aware Auto Caption

## 自動字幕への適用

Auto Processing dialogの字幕template選択は、単なる書き出し後の装飾ではない。選択IDから共有`getSubtitleTemplateSettings()`で次を同時に解決する。

- `style`
- `maxChars`
- `maxLines`

その値をworker request／caption segmentation設定と、初期`SubtitleClip`生成へ渡す。したがって最初に生成された字幕から選択templateの見た目と表示制約を持つ。

`edit_project.v1`、workerの内部実装、字幕trackの後付け一括style変更は初期caption生成の代替として使わない。

## default

Auto Processing dialogはapp-level userData設定`lastUsedSubtitleTemplateId`を起動時に読み込み、最後に成功適用したtemplateを初期template・文字数・行数・品質へ反映する。templateを選択したときもstyle previewと3つの生成値を一緒に切り替える。単なる選択ではlast-usedを更新せず、実際にAuto Processingが成功して字幕をTimelineへ適用した時点をauthorityとする。

選択templateの`maxChars`、`maxLines`、`segmentationMode`、`subtitleTemplate` IDは同じAuto Caption requestへ渡す。worker resultはそのcaption segmentationを正として受け取り、Studio adapterはmaxChars違反をProject適用前にrejectし、maxLinesをSubtitleClipへ保存する。Preview／Final layoutはそのclip maxLinesを参照するため、styleだけを後付けする経路はない。

## 既存字幕trackへの一括適用

字幕Inspectorの「字幕track全体へ適用」は、現在選択中字幕と同じsubtitle trackだけへtemplate styleを適用する。Project Modelを1回だけ更新するため、Undo 1回で一括変更全体を戻せる。

既存字幕の本文・timing・word ownershipは変更しない。`maxChars`/`maxLines`は新規生成時の制約であり、既存字幕trackへの一括適用では黙って再分割しない。既存字幕の再分割が必要な場合は、ユーザーが明示的に編集操作を行う。

## 検証

- template settings helperでstyle/maxChars/maxLinesの同時解決を回帰テスト
- `spectra-app-settings.v1.json`へtemplate IDだけを保存し、path、machine、ProjectFile情報は保存しない
- last-used templateが削除済み／不正IDの場合は`default`へfallbackし、その値を再保存する
- Auto Processing dialog内の個別maxChars/maxLines/quality変更はcustom overrideとして表示し、template本体をsilent updateしない
- 24文字／1行、32文字／2行をworker request、baseline settings、generated SubtitleClip、Render Specで検証
- worker captionが選択maxCharsを超えた場合はatomic applyを拒否し、既存human-corrected trackを含むProjectを変更しない
- rerunは選択templateで新規subtitle trackへ適用し、既存trackを上書きしない
- user templateの初期caption適用を既存adapter testで維持
- selected subtitle trackだけの一括style適用とUndo単位を回帰テスト
- `npm.cmd run check`: 48 files / 264 tests
- `npm.cmd run build`
- `npm.cmd run smoke:electron`
- `npm.cmd run smoke:accurate-preview`
