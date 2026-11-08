import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'

export const IconButton = ({
  label,
  active = false,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; children: ReactNode }): React.JSX.Element => (
  <button
    type="button"
    className={`icon-button ${active ? 'is-active' : ''} ${className}`}
    title={label}
    aria-label={label}
    aria-pressed={active || undefined}
    {...props}
  >
    {children}
  </button>
)

export const Button = ({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element => (
  <button type="button" className={`button ${className}`} {...props}>
    {children}
  </button>
)

export const Field = ({
  label,
  hint,
  children,
  wide = false
}: {
  label: string
  hint?: string
  children: ReactNode
  wide?: boolean
}): React.JSX.Element => (
  <label className={`field ${wide ? 'field-wide' : ''}`}>
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
)

/**
 * Number input that keeps what the user is typing while it has focus. Without the
 * draft, a controlled value that is reformatted on every keystroke (e.g. "1" ->
 * "1.00") makes it impossible to type "1.5", and an emptied field would commit 0.
 * Only complete, valid numbers reach `onChange`; blur shows the model value again.
 */
export const NumberField = ({
  label,
  suffix,
  value,
  onChange,
  onBlur,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; suffix?: string }): React.JSX.Element => {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // A change that did not come from typing in this focused input (undo, spinner
  // without focus, programmatic update) must show the model value again.
  useEffect(() => {
    if (draft !== null && document.activeElement !== inputRef.current) setDraft(null)
  }, [value, draft])
  return (
    <Field label={label}>
      <span className="number-input">
        <input
          type="number"
          ref={inputRef}
          {...props}
          value={draft ?? value}
          onChange={(event) => {
            setDraft(event.target.value)
            if (event.target.value === '' || event.target.validity?.badInput) return
            onChange?.(event)
          }}
          onBlur={(event) => {
            setDraft(null)
            onBlur?.(event)
          }}
        />
        {suffix && <span>{suffix}</span>}
      </span>
    </Field>
  )
}

export const SelectField = ({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }): React.JSX.Element => (
  <Field label={label} wide>
    <select {...props}>{children}</select>
  </Field>
)

export const Section = ({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }): React.JSX.Element => (
  <details className="inspector-section" open={open}>
    <summary>{title}</summary>
    <div className="inspector-section-body">{children}</div>
  </details>
)

export const EmptyState = ({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }): React.JSX.Element => (
  <div className="empty-state">
    <div className="empty-state-icon">{icon}</div>
    <strong>{title}</strong>
    <p>{text}</p>
    {action}
  </div>
)
