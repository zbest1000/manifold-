/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#ffffff',
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          800: '#1e293b',
          900: '#0f172a',
          950: '#0a0f1c'
        },
        accent: {
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7'
        }
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'JetBrains Mono', 'Menlo', 'Consolas', 'monospace']
      },
      // A deliberate type scale with matching line-heights, so UI text stops
      // hand-picking arbitrary [10px]/[11px] sizes. Minimum readable step is 12px.
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }], // 11px — dense labels only
        xs: ['0.75rem', { lineHeight: '1.1rem' }], // 12px
        sm: ['0.8125rem', { lineHeight: '1.25rem' }], // 13px — default UI body
        base: ['0.9375rem', { lineHeight: '1.5rem' }], // 15px
        lg: ['1.0625rem', { lineHeight: '1.6rem' }], // 17px
        xl: ['1.25rem', { lineHeight: '1.75rem' }], // 20px — page titles
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }]
      }
    }
  },
  plugins: []
};
