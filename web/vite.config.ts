import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [preact()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // npm run dev:web 로 프런트만 띄울 때, API 는 wrangler dev(8787)로 보낸다.
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/auth": "http://localhost:8787",
    },
  },
});
