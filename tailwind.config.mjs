/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#F97316',
          dark: '#9A3412',
          light: '#FFEDD5'
        },
        flame: {
          DEFAULT: '#EF4444',
          dark: '#7F1D1D'
        },
        ink: {
          DEFAULT: '#0B1120',
          soft: '#1E293B'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      }
    }
  },
  plugins: []
};
