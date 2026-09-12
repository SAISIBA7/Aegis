import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "#F6F4EE",
        parchment: "#EFECE4",
        ink: {
          DEFAULT: "#1A1816",
          muted: "#6B665E",
          subtle: "#8C867A",
          rule: "#E2DDD4",
          "rule-dark": "#D4CDC2",
        },
        brand: {
          50: "#FFF5F0",
          100: "#FFE6D9",
          500: "#FF4F00",
          600: "#E04500",
          700: "#C03B00",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
