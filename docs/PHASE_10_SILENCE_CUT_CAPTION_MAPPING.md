# Stage 10: Silence Cut + Caption Time Mapping

## Source authority

source absolute integer microsecondsが唯一の時間正本である。字幕を先に元timelineへ作成し、後から一括shiftする方式は使用しない。

`createSilenceCutTimeMapper(originalClip, keepRanges)`が、keep rangeとremoved rangeを同時に保持する共有pure mapperを返す。

```text
source 0–5s   → output 0–5s
source 5–8s   → removed
source 8–15s  → output 5–12s
source 10s    → output 7s
```

## 共通利用

同一mapperを次のすべてへ適用する。

- raw Whisper wordのremoved-range検査
- caption start/end
- `SubtitleWord` start/end
- `SubtitleEditUnit` start/end（mapped SubtitleWordからderived生成）

caption／word intervalのsource時間がremoved rangeを跨ぐ場合は、keep plan適用前にsourceから再計算する。raw Whisper wordがremoved rangeに少しでも重なる場合、`CUT PLAN INVALID`として全適用をrejectし、発話wordを削除して続行しない。

reject時はProjectFile、media file、historyを変更しない。
