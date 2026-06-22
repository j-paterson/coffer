import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Ports are env-configurable so a dev instance and a live dog-fooding instance
// can run side by side. Defaults preserve the original 5173 / 3001 setup.
const apiPort = process.env.PORT ?? "3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
