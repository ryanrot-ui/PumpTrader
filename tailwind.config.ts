import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Photon/Axiom-inspired dark trading palette
        surface: {
          DEFAULT: "#0b0e14",
          raised: "#11151f",
          overlay: "#161b28",
          border: "#232a3b",
        },
        accent: {
          DEFAULT: "#6366f1",
          hover: "#818cf8",
        },
        profit: "#22c55e",
        loss: "#ef4444",
        warn: "#f59e0b",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      animation: {
        "pulse-fast": "pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "slide-in": "slideIn 0.15s ease-out",
      },
      keyframes: {
        slideIn: {
          "0%": { opacity: "0", transform: "translateY(-4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
