/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // optional: keep Inter alias
        inter: ['Inter', 'sans-serif'],
        // default sans will be DM Sans with sensible fallbacks
        sans: ['"DM Sans"', 'Inter', 'system-ui', 'sans-serif'],
        // optional: dedicated utility
        dm: ['"DM Sans"', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        yggdrasil: {
          green: '#00ff88',
          dark: '#050505',
          accent: '#1a1a1a',
        },
      },
      spacing: {
        // Custom spacing values to support existing usage
        // These map to the invalid classes currently in use
        15: '60px', // ml-15
        35: '140px', // mr-35
        90: '360px', // w-90 (sidebar width)
      },
      flex: {
        // Custom flex values to support existing usage
        2: '2 2 0%',
        4: '4 4 0%',
      },
      letterSpacing: {
        // Custom letter spacing for Yggdrasil heading
        'ygg-wide': '0.25em',
      },
      keyframes: {
        menuEntrance: {
          from: { opacity: '0', transform: 'scale(0.95) translateY(10px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
      },
      animation: {
        menuEntrance: 'menuEntrance 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
}
