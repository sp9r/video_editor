export const BrandMark = ({ compact = false }: { compact?: boolean }): React.JSX.Element => (
  <div className={`brand ${compact ? 'brand-compact' : ''}`} aria-label="Spectra Video Studio">
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
    {!compact && (
      <span className="brand-type">
        <strong>Spectra</strong>
        <small>VIDEO STUDIO</small>
      </span>
    )}
  </div>
)
