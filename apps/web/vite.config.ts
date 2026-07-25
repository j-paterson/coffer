import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `bun run --filter '@coffer/web' dev` runs vite with apps/web as cwd, and this
// config is evaluated by Node (not Bun), so neither Bun's cwd-based .env loading
// nor our Bun-only @coffer/config/env helper applies here. Use vite's own
// loadEnv against the repo root so a live instance's WEB_PORT / PORT (set in the
// root .env) take effect under `bun run dev`. Empty prefix loads all keys, not
// just VITE_-prefixed ones; process.env still takes precedence over the file.
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const rootEnv = loadEnv("development", repoRoot, "");
const env = { ...rootEnv, ...process.env };

// Ports are env-configurable so a dev instance and a live dog-fooding instance
// can run side by side. Defaults preserve the original 5173 / 3001 setup.
const apiPort = env.PORT ?? "3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(env.WEB_PORT ?? 5173),
    proxy: {
      "/api": {
        target: env.VITE_API_PROXY ?? `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
