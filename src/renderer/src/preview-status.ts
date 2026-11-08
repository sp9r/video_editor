export const previewQualityLabel = ({
  playing,
  exactCheck,
  exactShown,
  exactRendering,
  exactError
}: {
  playing: boolean
  exactCheck: boolean
  exactShown: boolean
  exactRendering: boolean
  exactError: string | null
}): string => {
  if (!exactCheck) return 'ライブ合成（書き出しと同じ配置・字幕）'
  if (playing) return 'ライブ合成（再生中は書き出し画質の確認を止めています）'
  if (exactShown) return '書き出し画質（FFmpegの1フレーム）を表示中'
  if (exactError) return 'ライブ合成 / 書き出し画質の取得失敗'
  if (exactRendering) return 'ライブ合成 / 書き出し画質を生成中…'
  return 'ライブ合成 / 書き出し画質を準備中…'
}
