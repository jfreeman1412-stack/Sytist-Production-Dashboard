// Shared primitives for the Settings pages. Inline styles to match the
// rest of the app's pattern. Lightweight on purpose — these aren't
// design-system components, just consistent building blocks for the
// five settings pages so they look like siblings.

import React from 'react';

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 24,
        paddingBottom: 16,
        borderBottom: '1px solid var(--border-color)',
      }}
    >
      <div>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <div
            style={{
              // Phase 26: 13 → 15.
              fontSize: 15,
              color: 'var(--text-muted)',
              marginTop: 4,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8 }}>{actions}</div>}
    </div>
  );
}

export function Section({ title, description, children, actions }) {
  return (
    <section
      style={{
        marginBottom: 32,
        padding: 20,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
      }}
    >
      {(title || actions) && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: description ? 4 : 16,
          }}
        >
          {title && (
            <h2
              style={{
                margin: 0,
                // Phase 26: 14 → 16.
                fontSize: 16,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                color: 'var(--text-secondary)',
              }}
            >
              {title}
            </h2>
          )}
          {actions && <div style={{ display: 'flex', gap: 8 }}>{actions}</div>}
        </div>
      )}
      {description && (
        <div
          style={{
            // Phase 26: 12 → 14.
            fontSize: 14,
            color: 'var(--text-muted)',
            marginBottom: 16,
          }}
        >
          {description}
        </div>
      )}
      {children}
    </section>
  );
}

export function FormRow({ label, hint, children, htmlFor }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {label && (
        <label
          htmlFor={htmlFor}
          style={{
            display: 'block',
            // Phase 24 bumped 12 → 13. Phase 26 bumped 13 → 15.
            fontSize: 15,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            marginBottom: 6,
          }}
        >
          {label}
        </label>
      )}
      {children}
      {hint && (
        <div
          style={{
            // Phase 24: 11 → 12. Phase 26: 12 → 14.
            fontSize: 14,
            color: 'var(--text-muted)',
            marginTop: 4,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

const baseInputStyle = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  color: 'var(--text-primary)',
  // Phase 24: 13 → 14. Phase 26: 14 → 16.
  fontSize: 16,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

export function TextInput({ value, onChange, placeholder, monospace, style, ...rest }) {
  return (
    <input
      type="text"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        ...baseInputStyle,
        fontFamily: monospace ? 'var(--font-mono, monospace)' : 'inherit',
        // Phase 11h: allow callers to override base style (e.g. larger
        // fontSize/padding for the order-overrides picker). Pull style
        // out of rest so it doesn't clobber baseInputStyle wholesale —
        // merge it on top instead.
        ...(style || {}),
      }}
      {...rest}
    />
  );
}

export function TextArea({ value, onChange, rows = 6, monospace, ...rest }) {
  return (
    <textarea
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      style={{
        ...baseInputStyle,
        fontFamily: monospace ? 'var(--font-mono, monospace)' : 'inherit',
        resize: 'vertical',
      }}
      {...rest}
    />
  );
}

export function Select({ value, onChange, options, ...rest }) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      style={baseInputStyle}
      {...rest}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function NumberInput({ value, onChange, step = 'any', ...rest }) {
  return (
    <input
      type="number"
      value={value ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === '' ? '' : Number(v));
      }}
      step={step}
      style={baseInputStyle}
      {...rest}
    />
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  type = 'button',
  ...rest
}) {
  const variants = {
    primary: {
      background: '#4a7fc1',
      border: '1px solid #4a7fc1',
      color: '#ffffff',
    },
    secondary: {
      background: 'var(--bg-input)',
      border: '1px solid var(--border-color)',
      color: 'var(--text-primary)',
    },
    danger: {
      background: 'rgba(220,53,69,0.15)',
      border: '1px solid rgba(220,53,69,0.4)',
      color: '#dc3545',
    },
    ghost: {
      background: 'transparent',
      border: '1px solid var(--border-color)',
      color: 'var(--text-secondary)',
    },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '7px 14px',
        borderRadius: 6,
        // Phase 24: 12 → 13. Phase 26: 13 → 15.
        fontSize: 15,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontFamily: 'inherit',
        ...variants[variant],
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Inline status indicator for save/load feedback. Pass `kind` 'success'|
 * 'error'|'info' and `message`.
 */
export function StatusBanner({ kind = 'info', message, onDismiss }) {
  if (!message) return null;
  const palette = {
    success: {
      bg: 'rgba(76,175,80,0.1)',
      border: 'rgba(76,175,80,0.4)',
      color: '#4caf50',
    },
    error: {
      bg: 'rgba(220,53,69,0.1)',
      border: 'rgba(220,53,69,0.4)',
      color: '#dc3545',
    },
    info: {
      bg: 'rgba(74,127,193,0.1)',
      border: 'rgba(74,127,193,0.4)',
      color: '#4a7fc1',
    },
    warn: {
      bg: 'rgba(224,179,65,0.1)',
      border: 'rgba(224,179,65,0.4)',
      color: '#e0b341',
    },
  };
  const p = palette[kind] || palette.info;
  return (
    <div
      style={{
        padding: '10px 14px',
        background: p.bg,
        border: `1px solid ${p.border}`,
        borderRadius: 6,
        color: p.color,
        // Phase 26: 13 → 15.
        fontSize: 15,
        marginBottom: 16,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span>{message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 16,
            padding: 0,
            lineHeight: 1,
          }}
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Token reference panel — small list of `{token}` chips with a description,
 * used by Paths, Darkroom filename, and Imposition (text overlays).
 */
export function TokenList({ tokens, title = 'Available tokens' }) {
  return (
    <div
      style={{
        padding: 12,
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 6,
        fontSize: 11,
      }}
    >
      <div
        style={{
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-muted)',
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {tokens.map((t) => (
          <span
            key={t.token}
            title={t.description}
            style={{
              padding: '3px 8px',
              borderRadius: 4,
              background: 'rgba(120,120,200,0.18)',
              color: '#aab',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 11,
              cursor: 'help',
            }}
          >
            {t.token}
          </span>
        ))}
      </div>
    </div>
  );
}

export const settingsStyles = {
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    // Phase 24: 12 → 13. Phase 26: 13 → 15.
    fontSize: 15,
  },
  th: {
    textAlign: 'left',
    padding: '8px 12px',
    // Phase 26: 11 → 13.
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    borderBottom: '1px solid var(--border-color)',
  },
  td: {
    padding: '8px 12px',
    borderBottom: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    verticalAlign: 'top',
  },
};
