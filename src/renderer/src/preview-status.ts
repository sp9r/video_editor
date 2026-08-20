export const previewQualityLabel = ({
  playing,
  accurateFrameMatchesCurrent,
  accurateRendering,
  accurateError
}: {
  playing: boolean
  accurateFrameMatchesCurrent: boolean
  accurateRendering: boolean
  accurateError: string | null
}): string => {
  if (playing) return '高速プレビュー'
  if (accurateFrameMatchesCurrent) return '正確プレビュー'
  if (accurateRendering) return '高速表示 / 正確プレビュー更新中…'
  if (accurateError) return '高速表示 / 正確プレビュー取得失敗'
  return '高速表示 / 正確プレビュー生成中…'
}
