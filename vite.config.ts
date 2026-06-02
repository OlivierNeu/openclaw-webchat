import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Mirrors the claude-monitor stack: Vite + React + Tailwind v4 plugin, "@" -> ./src.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // 5174 (not 5173) so it cohabits with claude-monitor's Vite on 5173.
  server: { port: 5174, strictPort: true },
});
