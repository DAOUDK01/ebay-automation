import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      keyframes: {
        "progress-slide": {
          "0%": { left: "-35%" },
          "100%": { left: "100%" },
        },
      },
      animation: {
        "progress-slide": "progress-slide 1.4s ease-in-out infinite",
      },
      colors: {
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
