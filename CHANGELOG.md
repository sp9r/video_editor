# 変更履歴

このプロジェクトはSemantic Versioningを目標とし、ユーザーから見える変更を記録します。

## [Unreleased]

### 2026-10-22 Export parity

- 実映像（1080p60のVFR・色タグなしH.264、107カット）で、プレビューと書き出しの違いを測って直した。プロジェクトのコピーの先頭15秒を実際に書き出し、そのフレームをプレビューのcanvas（DPR 1と2）・FFmpegの正確フレームと比べた（`scripts/real-footage-parity-check.mjs`）。
- 色: 書き出しは全チャンネルが約2段階暗かった。swscaleの既定のRGB/YUV変換は丸めず切り捨てるため、取り込み・出力・正確フレームの確認変換の3か所で約1段階ずつ暗くなっていた。Chromiumは色タグなしの1080pをBT.709（リミテッド）で正確に変換する（ソースの実測値と平均が0.1以内で一致）。変換のscaleに`accurate_rnd+full_chroma_int`を付けて、書き出しがBT.709の正確な値になるようにした。MP4のタグ（BT.709・tv）は従来どおり。変換1回あたり約2.7ms/フレーム増える（1080pの8秒で1.8秒から3.1秒）。
- 絵のフレーム: クリップの開始がフレームの間にあるとき、書き出しはそのクリップをその次のフレームから始め、そのフレームを基準にソースを送る。プレビューは開始時刻そのものを基準にしていたため、カットの先頭では1フレーム（33ms）先の絵を出していた。プレビューも同じ「クリップの最初のフレーム」から数えるようにした（`src/shared/clip-frames.ts`）。書き出しは、最初に見つかったソースフレームではなく、ソースのイン点を時刻0にそろえて送る（イン点の手前にソースのフレーム1枚分＋2msを読み込む）。以前は窓付きの正確フレームと全体の書き出しで、最初のソースフレームの位置がずれて、60fpsのソースで1/60秒違う絵を選ぶことがあった。半フレームちょうどのフレーム（60fpsの正確なソースなど）は、FFmpegとChromiumでマイクロ秒の丸めが違うため、両方で同じ側に倒す余裕（50マイクロ秒）を設けた。クリップの終わりも、プレビューが映す最後のフレームで切る。動画クリップの音声はイン点から始める。
- 測定（実映像、キャンバスの大きさで比較）: 平均の色の差（canvas−書き出し）はR/G/B +1.0/+1.1/+0.9 から -0.2/-0.1/-0.2、平均絶対差は8.2から2.6、SSIMは0.84から0.97（DPR 2では0.86から0.97）、プレビューが違うフレームを出したカットは18枚中7枚から0枚。FFmpegの正確フレームと書き出しの絵の不一致は18枚中1枚から0枚。残りの差は輪郭（拡大縮小・クロマの補間・H.264の圧縮）で、正確フレームと書き出しの差（平均絶対差0.9）が圧縮の分。
- フレーム番号を埋めた生成素材（色タグなし1080p・60fps・タイムスタンプのずれと欠けたフレーム付き）の検証: 書き出しと同じ絵を出す割合を、プレビュー46枚中8枚から44枚、FFmpegの正確フレームは41枚から46枚に上げた。最大のずれは3ソースフレームから1ソースフレーム。Chromiumはこの生成素材の一部のフレーム（欠けたフレームの近く）をシーク後に出さないため、プレビューには1ソースフレームのずれが残る（実映像では出ていない）。

### 2026-10-22 Preview subtitles

- 字幕画像の先読みは、ドラッグ・シーク・キー入力の間は止め、再生中は6秒先までに絞る。FFmpegはサムネイル・波形・字幕で3本を共有し、再生ヘッドの字幕は割り込んで最優先で作る。プロジェクトを開いてから最初の字幕が出るまでは3.7〜4.0秒から約0.8秒になった。

- プレビューの字幕を、書き出しと同じフレームで出し入れするようにした。字幕の表示範囲は共通の1つの規則（\`src/shared/subtitle-timing.ts\`）にした: 先頭は「時刻が開始以上の最初のフレーム」、終端（含まない）は「時刻が終了以上の最初のフレーム」。ASSには、その2フレームの時刻（libassに渡されるミリ秒）を10ミリ秒単位に切り下げた値を書く。以前はASSの開始を切り下げ、終了を切り上げていたため、30fpsで開始302msの字幕が書き出しでは1フレーム早く出ていた。24 / 30 / 29.97 / 60fpsで、時刻がフレームに乗らない字幕について、同梱FFmpegのlibassが字幕を出すフレームの集合とプレビューが計算する集合が一致することをテストした（100fps超では10ミリ秒の刻みに収まらないため保証しない）。1フレームに満たない字幕は、プレビューにも書き出しにも出ない。SRTは従来どおりミリ秒で出す。
- フェード・ポップ・スライド・タイプライターの動きも、同じフレーム単位の開始・終了から数える。動き中の画像は「字幕の見た目＋各字幕の経過ミリ秒」で識別するので、字幕をタイムライン上で動かしても画像を使い回せる。
- 字幕画像を先に作るようにした。プロジェクトを開く・字幕を変えると、必要な見た目をすべて数え上げ（字幕の出入りと動きのフレームだけ）、再生ヘッドに近い順（先を見て、後ろは後回し）にバックグラウンドで描く。FFmpegは1回の起動で最大48枚をまとめて描く（同じ画像を字幕ごとのスロットに並べ、\`ass\`は黒・白の2つだけ）。再生ヘッドの画像は他の処理を待たせず1枚だけで先に頼む。シークすると順序を取り直す。編集した字幕だけを描き直す。画像はパスだけをIPCで受け渡し、再生ヘッドの先4秒分を先にデコードする。画像がまだ無い間は、同じ字幕の直前の画像か何も出さない（別の字幕は出さない）。
- 字幕画像のキャッシュ上限を240枚・128MBから1500枚・384MBに上げた。新しいIPC \`preview:subtitle-frames\`（\`renderSubtitleFrames\`）を追加。
- 実プロジェクトのコピー（1920x1080 30fps、字幕151件、Noto Sans JP ExtraBold 120px）での測定: 全151画像の描画は約8〜14秒（1枚あたり約40ミリ秒＋起動約0.4秒、他のプロセスでCPUが埋まっていた時の値）。20秒再生で、字幕が出るべきサンプルのうち、起動直後の約2秒を除いて100%が正確な字幕。別の場所へシークして再生した直後の15秒は99.7%（シーク後の最初の1サンプルだけ未着）、シークから1秒後以降は100%。字幕のテキストを変えてから新しい画像が出るまでは約0.5秒。以前は同じ条件で字幕が出るべき125サンプル中113（90%）だった。

### 2026-10-22 Caption settings can be changed after generation

- 作成済みの字幕の設定を後から変えられるようにした。字幕トラックの見出しの字幕アイコン、またはInspectorの「字幕設定を変更…」から開く。対象は「このトラックのすべて」か「選択中の字幕」。最大文字数・横幅の上限・最大行数・区切り方式・テンプレート・フォント・サイズ・色・縁取り・縦位置を変えられる。
- 見た目だけの変更はすぐ反映する。文字数・横幅・行数・方式・フォントサイズの変更は、字幕が持つ単語から分け直す（音声の再認識なし）。分け直しはworkerの区切り処理（`generate_subtitles`）をそのまま使い、TypeScriptに区切りの実装は増やしていない。どちらも1回のUndoで戻る。
- 新しいworker契約`spectra.auto-caption.resegment.request.v1` / `.result.v1`（単語だけを送る。音声なし・Whisperなし）と、`clip_automation/spectra_caption_resegment.py`を追加した。既存のauto-caption契約は変えていない。IPCは`auto-caption:resegment`を追加。
- 手で編集した字幕（単語情報がない、または本文と単語が一致しない）は分け直さず、その場に残して折り返しだけ新しい設定にする。件数を完了メッセージで知らせる。分け直した字幕が残した字幕と重ならないよう、run（連続した分け直し対象）ごとにworkerへ渡す。
- 字幕トラックに最後に使った設定（`captionLayout`）を保存し、パネルの初期値と次回の自動処理の既定値にする。
- 日本語の折り返しを改善した。Intl.Segmenterの単語に、助詞・助動詞・語尾を前につける小さな規則を加え、行数が最小のまま行の長さを揃える（「解説し/ます」「エントリーシート/を」を出さない）。`layoutSubtitleText`を直したので、プレビューとASSは同じ改行になる。

### 2026-10-22 Caption layout settings

- 自動字幕に「横幅の上限（%）」と「最大行数」を、最大文字数とは別に設定できるようにした。自動処理のダイアログと字幕テンプレートの生成設定に3つを並べて出し、現在のフォント・サイズ・横幅から「1行に約12文字、2行で約24文字まで」の目安を表示する。
- workerへ1行の文字数（`lineCapacity`、契約の任意項目）を渡す。使う文字数の上限は最大文字数と「1行の文字数 × 最大行数」の小さいほう。workerは最後に、各字幕が文節・単語を途中で切らずに最大行数へ折り返せるか確かめ、収まらない字幕を文節の区切りで分割する（折り返しの幅モデルは `layoutSubtitleText` と同じ。`src/shared/subtitle-layout.ts` の `subtitleLineCapacity` / `measureSubtitleTextWidth`）。
- 生成した字幕のclipに最大行数と横幅を保存する。Inspectorの字幕テキストの下に「2 / 2行」の行数表示と超過警告、文字スタイルに字幕ごとの「最大行数」を追加した。
- 実音声（A_job_interview 60秒、120px ExtraBold、幅80%、ルール方式）で確認: 最大行数1のとき、変更前は24字幕中9字幕が2行に溢れたが、変更後は34字幕すべて1行（最長12字）に収まった。

### 2026-10-22 Added

- クリップの移動とトリムにスナップを付けた。他クリップの先頭・末尾、再生ヘッド、0秒に8pxで吸着し、吸着位置に縦線を出す。`S`で切り替え、`Alt`を押している間は無効。

### 2026-10-22 Fixed

- クリップの移動・トリム中、リンクした相方（映像と音声）がドラッグ中も同じ量だけ動くようにした。以前は離したときに初めて動いていた。表示は実際の確定処理を現在のプロジェクトに適用した結果で、離したときの結果と一致する。
- クリップをつかんだだけで再生ヘッドが動かなくなった。再生ヘッドの移動は、ドラッグせずにクリックして離したときだけ。以前はつかんだ時点で動くため、元の先頭位置にスナップして小さな移動が戻っていた。
- 大きなプロジェクト（映像・音声600クリップ＋字幕300）でクリップをドラッグするとカクついていたのを直した。ドラッグ中はつかんだクリップとリンクした相方だけを再描画し、他のクリップは再描画しない（以前は全クリップを描き直していた）。ポインタ移動は1フレームに1回へまとめ、離したときの確定位置・スナップは従来どおり。再生中も再生ヘッドの更新でクリップ一覧を描き直さない。編集の確定（ドラッグを離したとき・元に戻す・やり直す）でも、内容が変わっていないクリップ・トラック・メディアは以前のオブジェクトを使い回し、動いていないクリップを描き直さない。

### 2026-10-21 Changed / Fixed

- プレビューを1枚のcanvasによる合成に作り直した。再生中と停止中で描き方が同じになり、書き出しと同じ配置の数値（`src/shared/visual-layout.ts`）を使う。字幕はlibassの画像で、アニメーションは1フレームずつ描く。停止時にFFmpegの画像へ自動で切り替えるのはやめ、「書き出し画質で確認」をオンにしたときだけ表示する。
- 書き出しの合成順序をプレビューに合わせた。クロップは残りの部分を動かさない。回転しても縮めない。書き出し解像度がシーケンスと違うときは、シーケンスで合成してから縮小し、縦横比が違えば黒帯を入れる。
- 書き出しの色をBT.709で変換し、MP4に色のタグを付けた。入力の色空間とスマホ動画の回転情報を読むようにした。
- 正確プレビューは、目的のフレームの直前から合成する。長い動画の後半でも待たない。1フレーム早くずれる不具合も直した。
- 字幕の半透明の背景が、プレビュー用の画像でほぼ消えていた問題を直した。
- コマ送り（矢印キー・ボタン）がシーケンスのフレームレートに合わせて進む。以前は常に1/30秒だった。
- 編集機能の不具合を直した。
  - 分割ツール（C）が映像・音声・画像で効かなかった。何も選んでいないときのCtrl+Kは、再生ヘッド上のクリップをすべて分割する。
  - Ctrl+Cなど修飾キー付きの操作で、V/C/Sのツール切り替えが動いていた。
  - スライダーやチェックボックスを触った後、Ctrl+Z・Delete・Ctrl+Kが効かなかった。
  - 「自動詰め」がDeleteキーで効かなかった。ロック中のトラックが詰め削除で動いていた。
  - クリップをクリックすると再生ヘッドがクリップの先頭へ飛んでいた。
  - 素材を読み込み直すと、タイムライン上のクリップの参照が壊れていた。
  - 配置・貼り付け・字幕追加の時刻がフレームに乗っていなかった。トリムで開始時刻が負になる場合があった。
  - 何も変わらない操作でも取り消しの履歴が増えていた。削除や取り消しの後に、消えたクリップが選択されたままになっていた。
  - 未保存のまま別のプロジェクトを開くと、確認なしに破棄されていた。保存ダイアログ中の編集が消えていた。
  - Inspectorの数値欄で「1.5」のような小数を打てなかった。空欄にすると0になっていた。
  - SRT/VTTの読込で、既存の字幕が動いていた。ロック中のトラックを無視し、不正な時刻のキューを弾いていなかった。
  - Ctrl+Dで複製したクリップが元のクリップの真上に重なっていた。

### 2026-10-18 Fixed

- プレビューで音量を上げると例外になる問題を修正。音量・左右バランス・フェードをFinalと同じ設定で再生する。
- パン入力を百分率で表示し、保存時に正しい[-1,1]の値へ変換する。
- 素材のbyte-range配信とネイティブ再生時計への同期を修正し、AAC再生中の連続シークを防ぐ。
- 音声が途中停止した場合の再開、再読込後の正確プレビュー、字幕切替時の古い画像残留を修正する。
- デスクトップ起動時に架空素材のデモを読み込まず、空プロジェクトを開く。
- 読み込み中・シーク中の再生位置の連続更新を抑え、音声と映像のシーク完了後に最新位置へ同期する。
- MP4とSRTの書き出し失敗時に元ファイルを復元し、復元できない場合もエラーで知らせる。同じ出力先への二重保存を拒否する。
- 字幕が0件のSRT出力で古い字幕が残る問題を修正する。
- 自動検証の設定・復元データ・キャッシュを普段の利用環境から分離する。

### 2026-08-16 Night 24 verification

- 実人間日本語QA AでAuto Processingから手動字幕編集、Save/reopen、final renderまでの最終GUI smokeを確認した（666 raw words、85 captions、Natural silence 3件）。
- user subtitle templateのlast-used復元をSave/reopen後に確認した。高品質字幕区切りはLLM timeout時に既存rule fallbackを使用した。
- GUIの実encoder probeがCPU/libx264を選択したため、今回の最終出力はCPU fallbackとして記録した。NVENC成功とは混同しない。

### Fixed

- Integrated Auto Editの成功／失敗／キャンセル境界を整理し、worker、無音cut、字幕template、baseline、Project適用を成功時の1 history operationとして扱う回帰を追加した。Full Correction beforeは自動編集後のcompressed timelineを保持する。
- offline素材をメディア棚から再リンクし、既存timeline clipのasset IDを保ったままpath／metadataを更新できるようにした。
- 書き出し画面の「ハードウェア」を「ハードウェア優先」へ改め、GPU失敗時にCPUへfallbackする実装と説明を一致させた。
- Windows NSIS installerとportableが同一ファイル名で上書きされる設定を修正し、`-setup.exe`と`-portable.exe`を別々に生成するようにした。

### Verified

- 12 test files／54 tests、AMD AMFとCPU `libx264` の実H.264/AAC MP4出力・ffprobe・先頭／末尾decode、Windows x64 package buildを確認した。
- Subtitle template modelのbuilt-in immutable catalog、userData atomic CRUD、malformed record isolation、contract safe-ID validationを確認した。
- Subtitle Inspectorのtemplate manager、defaultTemplateIdのmigration-safe persistence、sample preview、built-in保護を確認した。
- Auto Caption template selectionのstyle/maxChars/maxLines初期適用と、既存subtitle trackへの一括style適用（one-step Undo）を確認した。
- built-in subtitle templateを標準・白文字黒縁・大きめ強調の3種類へ整理し、1920×1080 libass実レンダリングQAを追加した。
- Integrated Auto Editのselected template適用、Undo/Redo、worker failure、started-job cancellation、Full Correction baseline timingを検証した。

### Planned

- Electron実画面E2Eと別PC受入試験（未完了）
- 実program monitorの複数映像・音声同期、proxy、波形
- native dialogを含むoffline素材再リンクの実画面受入
- Windows installerの対話導入・アンインストールと別PC移植
- Whisper／ローカルLLM／OpenAI互換providerのUI統合
- より高度な字幕animation、transition、color、keyframe

## [0.1.0] - 2026-08-12

### Added

- Electron / React / TypeScriptのデスクトップ動画編集基盤
- 独自の黒鉛＋ミント編集ワークスペース
- メディア棚、program monitor、inspector、5 track timeline
- 移動、trim、split、delete、ripple delete、Undo / Redo
- crop、position、scale、rotation、opacity
- volume、pan、fade、track mute
- 字幕編集、style、5種類のeffect preset、SRT/VTT import、SRT export、ASS burn-in
- `.spectra`project、relative path、offline検出、recovery autosave
- 同梱FFmpeg / ffprobeの解決と安全なargv実行
- NVENC、QSV、AMF、VideoToolbox、VAAPI、libx264 adapter
- GPU実encode probe、CPU fallback、progress、cancel、partial output、完成検証
- path-free AI provider registry、mock、local LLM／OpenAI互換HTTP adapter、検証済み編集command
- 12 test files／53 testsとbundled FFmpeg integration test

### Known limitations

- 実用アルファ。program monitorの合成・音声再生、proxy／波形は未完成。
- Windows配布物と他PCでの受入試験は未完了。
- 高度なprofessional NLE機能と実AI providerはロードマップ段階。
# 2026-08-15 — Stage 9 Human Review readiness handoff

- 実生成QA動画で、import → real Whisper auto-caption → manual correction → Save/reopen → Full Correction diff → Review Mode → burned-subtitle renderを受入。
- Inspector本文編集でraw word/editUnitと本文が不一致になった場合、derived timing metadataを削除して偽のword truthを残さないよう修正。
- worker contract、vertical slice、Full Correction Reviewの利用者向け文書を追加。
- self-contained portable auto-captionとfine acoustic alignmentは未達として明記。
