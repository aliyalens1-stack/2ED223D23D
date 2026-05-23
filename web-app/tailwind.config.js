/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ─── AutoSearch Light palette (Sprint 14) ────────────────────
        // ink.* preserved as token names for back-compat with legacy
        // pages, but values are remapped to a light grayscale.
        ink: {
          0:   '#ffffff',
          50:  '#f9fafb',
          100: '#f6f7f9',  // page background
          200: '#f3f4f6',  // surface elevated (chips)
          300: '#e5e7eb',  // hairline / dividers
          400: '#d1d5db',
          500: '#9ca3af',  // soft text
          600: '#6b7280',  // muted text
          700: '#4b5563',
        },
        amber: {
          DEFAULT: '#f5b800',
          50:  '#fff8d9',
          100: '#fff2b3',
          300: '#fbd84a',
          400: '#facc15',
          500: '#f5b800',
          600: '#d9a200',
          700: '#b88600',
        },
        brand:   { DEFAULT: '#f5b800', hover: '#d9a200', light: '#fff4cc', dark: '#b88600' },
        accent:  { DEFAULT: '#f5b800', light: '#fff4cc', dark: '#d9a200' },
        primary: { DEFAULT: '#f5b800', hover: '#d9a200' },
        hairline: '#e5e7eb',
        success: { DEFAULT: '#16a34a', light: '#dcfce7' },
        warning: { DEFAULT: '#f59e0b', light: '#fef3c7' },
        danger:  { DEFAULT: '#dc2626', light: '#fee2e2' },
        surface: '#ffffff',
        'surface-soft': '#f9fafb',
      },
      fontFamily: {
        display: ['"Inter"', 'system-ui', 'sans-serif'],
        body:    ['"Inter"', '"IBM Plex Sans"', 'sans-serif'],
        heading: ['"Inter"', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        tightest: '-0.04em',
        bracket:  '0.18em',
        widest:   '0.2em',
        nav:      '0.05em',
        bebas:    '0',
      },
      borderRadius: {
        DEFAULT: '10px',
        tight:   '8px',
        base:    '10px',
        lg:      '14px',
        xl:      '14px',
        '2xl':   '20px',
        modal:   '16px',
      },
      boxShadow: {
        'card':        '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)',
        'float':       '0 4px 12px rgba(15,23,42,0.08), 0 16px 40px rgba(15,23,42,0.12)',
        'amber-ring':  '0 0 0 3px rgba(245,184,0,0.18)',
        'hairline':    '0 0 0 1px #e5e7eb',
        none:          'none',
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      keyframes: {
        'fade-up':     { '0%': { opacity: '0', transform: 'translateY(12px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'amber-pulse': { '0%,100%': { boxShadow: '0 0 0 0 rgba(245,184,0,0.5)' }, '50%': { boxShadow: '0 0 0 12px rgba(245,184,0,0)' } },
      },
      animation: {
        'fade-up':     'fade-up 0.4s ease-out forwards',
        'amber-pulse': 'amber-pulse 2.4s ease-out infinite',
      },
    },
  },
  plugins: [],
};
