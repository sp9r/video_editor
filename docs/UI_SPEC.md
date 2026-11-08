# UI仕様

## 独自性

操作概念は一般的なトラック型NLEに合わせるが、他社製品のロゴ、画像、icon、固有名称、panel寸法、配色を複製しない。Spectra Video Studioは黒鉛色とミント色を基調にする。

| token | 値 | 用途 |
|---|---|---|
| `--bg` | `#111318` | app背景 |
| `--panel` | `#191D24` | panel |
| `--panel-raised` | `#212630` | toolbar／selected surface |
| `--border` | `#343B48` | border |
| `--text` | `#F2F5F8` | main text |
| `--muted` | `#9DA7B8` | secondary text |
| `--accent` | `#43D6B1` | primary action／playhead |
| `--warning` | `#F0B95A` | warning |
| `--danger` | `#FF6B72` | error／offline |

## Desktop layout

```text
┌ Project / save state ─ Workspace ─ Undo Redo ─ Export ┐
├ Media bin ─────────┬ Program monitor ───────┬ Inspector ┤
│ import/search      │ composited sequence    │ clip props│
├───────────────────┴────────────────────────┴───────────┤
│ edit tools / snap / zoom / timecode                     │
├ Track headers ───────── Multi-track timeline ──────────┤
└ Engine / autosave / encoder / export progress ─────────┘
```

- minimum 1180×720、target 1600×980。
- 左media panelと右inspectorはscroll独立。
- timelineは下部を優先し、clip名、start、duration、offline／mute状態を判別できる。
- program monitorはsequence aspect比を維持しletterboxする。
- 狭い幅ではpanelを折り畳み、monitorとtimelineを残す。

## 状態表現

- 未保存: project名横へdotと「未保存」。保存成功後に時刻を表示。
- offline asset: 赤outline＋`OFFLINE` label＋再リンクbutton。
- selected clip: accent outline、inspector内容と同期。
- locked track: edit操作を拒否しlock iconを表示。
- muted/hidden: iconと文字の両方を変える。
- export中: encoder名、stage、percentage、cancelを同じ領域に表示。
- fallback: 成功扱いのまま隠さず、GPU失敗理由とCPU利用を表示。

## 操作

| 操作 | 結果 |
|---|---|
| Mediaをdouble click / add button | 適合track末尾へ配置 |
| Mediaをtimelineへdrop | pointer時刻／適合trackへ配置 |
| clip body drag | timeline位置移動 |
| clip左右edge drag | source trim |
| playhead click/drag | seek |
| `Ctrl/Cmd+K` | selected clipをplayheadでsplit |
| `Delete` | clip削除、gap保持 |
| `Shift+Delete` | ripple delete |
| `Space` | 再生／停止 |
| `Ctrl/Cmd+Z` / `Y` | Undo / Redo |
| `+` / `-` | timeline zoom |

素材棚・timelineからの削除は、OS上の元ファイル削除を意味しない。

## Inspector

- Video/Image: position X/Y、scale、rotation、opacity、crop 4辺。
- Audio: volume dB、pan、fade in/out。
- Subtitle: text、font、size、text/outline/shadow/background、position、animation preset。
- 数値fieldは範囲をclampし、drag途中はpreview state、確定時だけUndo commandを作る。

## Accessibility

- buttonは見えるlabelまたは`aria-label`を持つ。
- keyboard focus ringを消さない。
- colorだけでclip type、warning、selectionを区別しない。
- tooltipへ機能名とshortcutを表示する。
- animationを減らすOS設定ではdecorative animationを停止する。

