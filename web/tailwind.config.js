/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#141414", 2: "#1f1f1f", 3: "#2a2a2a" },
        accent: { DEFAULT: "#e50914", 2: "#b20710" },
        ok: "#46d369",
      },
      fontFamily: { sans: ["'LG Smart UI'", "Roboto", "Helvetica Neue", "Arial", "sans-serif"] },
    },
  },
  plugins: [],
};
