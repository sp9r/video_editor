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

## Template Manager

ヘッダーの「テンプレート」から、ProjectFileの字幕選択状態に依存しない管理modalを開ける。built-inとuserを別一覧で表示し、種別をbadgeで識別する。選択templateのSubtitleStyle全field、maxWidth、animation、maxChars、maxLines、segmentationModeをdetailで確認できる。

Managerでは、新規作成、Timeline字幕から作成、適用、複製、名前変更、内容更新、削除、default設定を行える。built-inは直接更新・削除せず、複製してuser templateにする。Timeline字幕が選択されている場合だけTimeline由来の作成・適用を有効にし、Projectを開いていなくてもcatalogの閲覧とuser template管理は利用できる。

削除時は確認を表示する。削除対象がdefaultだった場合はmain-process serviceが`default`へ戻し、rendererも同じcatalogへ追従する。malformed user recordはserviceのload時に個別隔離され、正常なrecordとbuilt-inの表示を止めない。

## sample preview and parity

Inspector、Auto Processing、Template Managerのsample previewは、別々の縮小CSS計算を持たない。`SubtitleTemplatePreview`が1920×1080の仮想16:9 sceneを作り、`buildSubtitleRenderSpec()`、shared wrapping、anchor、maxWidth、font、outline、shadow、background、animationを同じ入力から計算する。表示領域へ縮小するだけなので、templateを保存した字幕へ適用した場合と同じgeometry semanticsになる。

静止字幕のFast Previewは`renderSubtitleOverlay()`によるASS/libass overlay、停止中のAccurate PreviewとFinalは同じlibass/Render Planをauthorityとする。Template Managerのsampleは編集時に軽量に確認できるpresentation previewであり、pixel authorityではない。CSS/libassのアンチエイリアス、blur形状、font rasterization差は許容する。

実FFmpeg回帰では、built-in 3種とTimeline字幕から作成した代表user templateを、次の日本語fixtureで比較する。

- 1行、2行、最大幅付近、長い日本語、数字・英字混在
- Accurate subtitle overlayとFinal libass frameのglyph center、line count、visibility
- template適用後のstyle/maxLinesとtemplate settingsの一致

この回帰は`tests/main/ffmpeg-integration.test.ts`の`representative timeline template`ケースで実施する。

## default persistence

storeは既存の`spectra.subtitle-template-store.v1`を維持し、`defaultTemplateId`を追加的に保存する。旧storeでこのfieldがない場合は`default`へmigrationする。削除されたuser templateがdefaultだった場合も`default`へ戻す。invalidなdefault IDは無視してcatalogを継続する。

ProjectFile、`edit_project.v1`、worker contractへtemplate pathやmachine-specific stateは保存しない。

## Timeline字幕からの保存

選択中の`SubtitleClip`が`sourceJobId`を持ち、対応する`experimental.auto-caption-baseline.v1`が読み込める場合、保存dialogのmaxCharsとsegmentationModeはそのbaselineのAuto Caption設定を初期値にする。baselineがない手動字幕や古い字幕は、現在のAuto Processing設定を初期値にする。どちらの場合も字幕本文の長さからmaxCharsを推測しない。

maxLinesはclipに保持された値を最優先し、未指定の場合だけbaseline、現在設定の順で補う。`maxWidthPercent`は選択字幕styleの値をtemplateのlayout constraintへコピーする。track内に異なるstyleが混在する場合は警告を表示し、選択中字幕のstyleを保存するauthorityとして明示する。

保存後のtemplateを別の字幕へ適用すると、SubtitleStyle全体とmaxLinesが同時に反映される。maxCharsとsegmentationModeは次回Auto Processingの生成設定として利用され、既存字幕clipへ推測値を書き戻さない。

Auto Processingで最後に成功適用したtemplate IDはStage 14のapp-level設定へ保存される。dialogでの選択や個別field変更だけではtemplate本体もlast-usedも変更せず、個別値はcustom overrideとして扱う。

## 検証

- userData serviceのbuilt-in/user default、unknown default、delete fallbackを回帰テスト
- Timeline字幕seed（baseline優先、current settings fallback、本文長非推測）と、template適用時のstyle/maxLines保持をshared testで検証
- `npm.cmd run check`: 51 files / 289 tests
- `npm.cmd run build`
- `npm.cmd run smoke:electron`
- `npm.cmd run smoke:accurate-preview`
- `npm.cmd run smoke:electron`: template managerを含むproduction rendererのasset、DOM、preload、console errorなしを確認
- `npm.cmd run subtitle:parity` / `npm.cmd run subtitle:geometry`: Fast/Accurate/Finalの既存pixel geometry gateを確認
- `tests/main/ffmpeg-integration.test.ts`: 代表user templateの日本語1行、2行、最大幅付近、長文、数字・英字混在をAccurate overlay／Final libassで確認
