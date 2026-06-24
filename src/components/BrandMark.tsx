import markUrl from '../assets/brand/judge-jury-mark.svg'

interface BrandMarkProps {
  compact?: boolean
}

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div className={compact ? 'brand brand--compact' : 'brand'}>
      <img src={markUrl} alt="" className="brand__mark" />
      {!compact && (
        <div className="brand__text" aria-label="Judge & Jury">
          Judge <span>&amp;</span> Jury
        </div>
      )}
    </div>
  )
}
