import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: { alias: { "@": "/src", "@shared": "/shared", "@worker": "/worker" } },
  build: { chunkSizeWarningLimit: 1500 },
  server: { watch: { ignored: ["**/test-results*/**", "**/playwright-report/**", "**/.wrangler/**", "**/connector/**", "**/docs/**"] } },
});
