export const BrandMark = ({ compact = false }: { compact?: boolean }): React.JSX.Element => (
  <div className={`brand ${compact ? 'brand-compact' : ''}`} aria-label="Cutline">
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
    {!compact && (
      <span className="brand-type">
        <strong>Cutline</strong>
        <small>動画編集</small>
      </span>
    )}
  </div>
)
