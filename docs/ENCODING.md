# エンコードエンジン実装ガイド

更新日: 2026-08-14

## 1. 実装範囲

`src/main/ffmpeg` は、projectをFFmpegで書き出すmain process専用モジュールである。

- 同梱`ffmpeg` / `ffprobe`の解決
- media metadataのprobe
- H.264 encoderのbuild確認と実機1-frame encode検査
- timelineからRenderPlan、filter graph、argvへの変換
- ASS焼き込み、SRT sidecar生成、SRT / WebVTT解析
- 書き出し進捗、キャンセル、GPU失敗時のCPU fallback
- ffprobeと先頭・末尾frame decodeによる完成検証
- 一時出力を使った入力・既存出力の保護

main IPCはこの層に含めない。`src/main/ffmpeg/index.ts`の公開APIをIPC handlerから呼び出す。

## 2. 最上位API

```ts
import { createFfmpegService } from './ffmpeg/index.js'

const service = await createFfmpegService()
const report = await service.detectEncoders()
const media = await service.probeMedia(mediaPath)

const job = await service.startExport(project, settings, {
  jobId,
  onProgress: (progress) => sendProgress(progress)
})

job.result.then(handleCompleted, handleFailed)
service.cancelExport(job.jobId)
```

`startExport()`は処理終了を待たず`ExportJob`を返す。IPC側は`jobId`をrendererへ返し、`job.result`を非同期監視する。公開メソッドは次のとおり。

| API | 用途 |
| --- | --- |
| `detectEncoders(force?)` | encoder report取得。`force=true`でcacheを破棄 |
| `probeMedia(path)` | metadataを取得。失敗時はreject |
| `probeMediaSafe(path)` | UI一括取込用。失敗を`ProbeResult.error`へ格納 |
| `createRenderPlan(project, settings)` | process起動を伴わないrender計画生成 |
| `renderAccurateFrame(project, timeUs, options?)` | Finalと同じauthoritative graphからcanonical PNGを生成 |
| `startExport(project, settings, options?)` | background export開始 |
| `cancelExport(jobId)` | 該当jobへAbortSignalを送り停止 |
| `writeSrt(project, outputPath)` | 字幕trackをSRTへ保存 |
| `parseSrt(text)` / `parseVtt(text)` | `{ startUs, endUs, text }[]`へ解析 |

テストでは`ProcessExecutor`を注入できる。アプリコードは既定の`executeProcess()`を使用する。

## 3. binary解決

優先順は明示option、環境変数、同梱packageである。

- FFmpeg: `ffmpegPath` → `FFMPEG_PATH` → `FFMPEG_BIN` → `ffmpeg-static`
- ffprobe: `ffprobePath` → `FFPROBE_PATH` → `ffprobe-static`

Electron package内の`app.asar`は`app.asar.unpacked`へ変換する。`package.json`の`asarUnpack`から両binaryを除外しないこと。解決時にread / execute可能性を検査し、不在時にPATH上の別binaryへ黙って切り替えない。

`ffmpeg-static`はGPL-3.0-or-laterである。配布物には`NOTICE.md`、該当license、FFmpeg build情報を維持する。

## 4. GPU判定とCPU fallback

`ffmpeg -encoders`はbuild能力しか示さない。各候補で128x128または本番解像度の1 frameを実際にencodeし、終了code 0になったものだけ利用可能とする。

| ID | Vendor | 実行対象 |
| --- | --- | --- |
| `h264_nvenc` | NVIDIA | Windows / Linux |
| `h264_qsv` | Intel | Windows / Linux |
| `h264_amf` | AMD | Windows / Linux |
| `h264_videotoolbox` | Apple | macOS |
| `h264_vaapi` | VAAPI | Linux |
| `libx264` | CPU | Windows / macOS / Linux |

VAAPIのみ`/dev/dri/renderD128`、次に`renderD129`を検査し、`format=nv12,hwupload`を使う。他のGPU encoderはsoftware frameを`nv12`で渡す。CPUは`yuv420p`で渡す。

候補順は利用可能なhardware adapter、最後に`libx264`である。`software` modeだけはCPUのみ。`hardware` modeでも、ユーザー要件に従い、実書き出し失敗時の最後の安全網としてCPUを残す。

次の段階でfallbackする。

1. 起動時encoder probeで利用不能なら候補から除外する。
2. 書き出し前に本番の幅・高さで再probeする。
3. FFmpeg初期化またはrenderが失敗したら次候補で一時出力を最初から作り直す。
4. 最終候補`libx264`で完走するか、全失敗を明示する。

キャンセル、権限不足、読取専用filesystem、入力欠落、空き容量不足ではfallbackしない。これらはencoderを変えても解決しないためである。選択encoderとfallback理由は`ExportProgress`へ含める。

## 5. RenderPlanとfilter graph

時間値は整数microsecondで保持し、FFmpegへ渡す直前だけ秒文字列へ変換する。入力file pathはfilter graphへ埋め込まず、必ず独立したargv要素として渡す。

transformの単位は次のとおり。

- `crop.left/top/right/bottom`: 入力寸法に対する`0.0`〜`0.49`の比率
- `positionX/Y`: 出力canvas中心からのpixel offset
- `scale`: canvasへ収めた状態を`1.0`とする倍率
- `rotation`: degree
- `opacity`: `0.0`〜`1.0`

visual処理はsoftware filterで統一する。

1. clipごとに`-ss` / `-t`で入力範囲を限定
2. `trim`、`setpts`でtimestampを0へ正規化
3. crop、rotate、scale、SAR、fps、opacityを正規化
4. clipの`startUs`をPTSへ加算
5. track順に背景canvasへoverlay
6. ASS字幕を焼き込み
7. encoder別pixel formatへ変換しH.264 encode

音声は48 kHz stereoへ正規化し、gain、pan、fade、timeline delayを適用して`amix`、`alimiter`へ渡す。音声clipがない場合も`anullsrc`を作り、完成MP4のstream構成を一定にする。

filter graphはUTF-8一時fileへ保存する。同梱FFmpeg 6.xでは`-filter_complex_script`、FFmpeg 7以降では`-/filter_complex`を使用する。Windows path、空白、日本語、`&`などをshell escapingへ任せない。

### Final / Accurate Previewの共通経路

Final書き出しとAccurate Previewは、同じ`RenderPlan`から`buildAuthoritativeVideoGraph()`を通る。字幕ASS、canvas、visual layer order、transform、opacity、audio semanticsを含むtimeline graphを先に構築し、末端だけを分ける。

- Finalはencoder pixel format、audio map、MP4 outputへ接続する。
- Accurate Previewは同じvideo graphの末尾へcanonical `select`を追加し、1 frameをRGBA PNGへ書き出す。audio branchは`anullsink`で明示的に消費する。
- inputをplayhead位置へshiftして別rendererを作らない。timeline semanticsを構築した後にframeを選ぶ。
- PNGは`accurate-preview/<cache-key>.png`へ一時出力し、非空検証後にatomic promoteする。rendererが出力先を指定することはない。

frame timeは`src/shared/frame-time.ts`のfloor semanticsを正本とする。30fpsでは0usと33333usはframe 0、33334usはframe 1である。Accurate Preview、Final比較fixture、将来のframe extractionは同じhelperを使う。

React/CSSは再生中のFast Previewで映像・画像を近似表示する。通常の`animation=none`字幕は`renderSubtitleOverlay()`が`generateAss(project)`をそのまま使い、透明RGBA canvasへ`ass=...:alpha=1`で描画したsequence全体PNGをoverlayする。停止中は従来どおり180ms debounce後にAccurate PNGをoverlayし、play開始時に隠す。project変更・seekの古いrequest結果はsequenceで破棄する。

Fast Previewの通常字幕はCSSのfont、outline、shadow、background、positionをauthorityとして使わない。`SubtitleRenderSpec`から生成された同じASSをlibassで描画するため、Noto Sans JP 0.67やArial 0.90のfont calibrationは通常字幕経路に存在しない。CSS 3-layerはanimated cueだけのtemporary fallbackであり、static overlay失敗・初回生成中・style変更中はCSSへfallbackしない。`data-subtitle-renderer="css-fallback"`はanimated fallbackの診断用である。

subtitle overlay cache keyはrenderer version、sequence width/height/fps、active subtitle visual state（active clip ID、track order、text、全style）から作り、media pathは含めない。memory/in-flight cacheは最大64件、同一static cueの再生中は同じPNGを再利用する。style/text/geometry/active cue変更でkeyが変わり、old requestはsequence guardで破棄する。animated cueはCSS fallbackへ明示的に降格する。

static subtitleの更新は40ms latest-onlyでcoalesceする。実行中の古いFFmpeg結果は表示せず、同一cueの最後のauthoritative overlayを保持してから新しいPNGへatomic swapする。次のstatic cueをprefetchし、boundaryではdebounceなしでcache hitを要求する。overlay生成失敗時は誤ったCSS字幕を出さず、保持可能な旧overlayまたは字幕なしとし、UIへ診断を表示する。

bundled FFmpegの`ass` filterは`alpha=1`を指定してalpha processingを有効化する。640x360透明fixtureでcorner alpha=0、glyph/outline/background/shadow alpha>0をpixel検証し、chroma keyは使用しない。

ASS BorderStyle 3のbackground eventはbundled libassの実挙動に合わせ、background色をPrimary/Outline/Backへ設定し、正のOutlineをpaddingとして与える。BackColourだけでは矩形が描画されないため、PrimaryColour transparentの旧形式は使用しない。backgroundはmain glyph・shadowとは別eventで、描画順はbackground → shadow → mainとする。

## 6. 字幕

subtitle trackのうち、enabledかつ非hidden・非mutedのclipをtimeline順に出力する。

- ASS: font、size、color、outline、background、bold、italic、letter spacing、alignment、positionを変換。background、shadow、main glyphは別style/eventに分離し、shadowBlurをmain glyphの`\\blur`へ直接流さない。shadow offsetはPreview既定の`0px,2px`、blurはshadow eventだけへlibass近似値として適用する
- animation: `fade`、`pop`、`slide-up`をASS override tagへ変換
- `typewriter`: Unicode graphemeを壊さないfadeへ安全に近似
- text: backslash、波括弧、改行をescapeし、ASS command注入を防止
- SRT: YouTube用sidecarとしてMP4と同じbasenameへ保存可能
- import: BOM、CRLF、cue ID、複数行、VTT cue settingsとNOTE blockを処理

ASSにportableなline-heightや完全なtypewriter表現はない。previewとの差異を隠さず、将来高度な字幕animationを導入する場合はframe生成または別rendererを検討する。

## 7. processと安全性

processは`spawn(command, argv, { shell: false, windowsHide: true })`で起動する。

- user文字列からshell commandやfilter expressionを生成しない
- stdout / stderrを上限付きで収集する
- `-progress pipe:1`の`out_time_us`から進捗を算出する
- AbortSignalでFFmpegを停止し、キャンセル時は別encoderへ移らない
- outputは`.part-<jobId>-<attempt>.mp4`へ書き、検証成功後だけ最終名へ移す
- outputと同一path / inodeの入力は拒否する
- output directory内の既存fileは、Windowsの置換時にbackupへ移して失敗時に戻す
- job workspaceは安全なjob IDから作り、終了時に再帰削除する

出力先は現在MP4のみを受理する。H.264、AAC、stereo、`+faststart`を既定とする。

## 8. 完成検証

FFmpeg終了code 0だけでは成功としない。ffprobe JSONで次を検査する。

- video streamの存在
- 指定した幅・高さ
- audio streamの存在
- project durationとの差が3 frameまたは250 ms以内

続いてFFmpegで先頭frameと末尾付近のframeを1枚ずつnull出力へdecodeする。検証完了前に既存の最終出力を変更しない。

## 9. テスト

```powershell
npm.cmd run typecheck
npm.cmd test
```

FFmpeg領域の主なtestは次のとおり。

- binary / asar path解決
- ffprobe JSONと完成条件
- encoder table解析、実encode成功・失敗、優先順位
- crop / overlay / audio mix / graph file / argv生成
- ASS / SRT生成、SRT / VTT解析
- GPU失敗→CPU fallback、進捗、キャンセル、入力上書き拒否
- 同梱FFmpegによるlossless fixture生成からH.264/AAC完成検証までの統合試験

`tests/main/ffmpeg-integration.test.ts`は実binaryを起動する。CI既定はCPUで決定的に検証し、各GPU adapterの実機試験は対応runner上で追加する。

## 10. 現在の制約

- working color spaceはBT.709 SDR相当。HDR tone mappingとcolor managementは未実装
- GPU decodeは強制しない。crop、overlay、ASS、mix後の最終encodeだけをGPU化する
- codecはH.264、containerはMP4に限定
- stream copyによる無劣化trim / concatは行わず、frame精度を優先して再encodeする
- transition、速度変更、高度なcolor gradingはRenderPlan adapterの追加が必要
- hardware encoderの画質optionはvendor間で互換でないため、adapter別に管理する
