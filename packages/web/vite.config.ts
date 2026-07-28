import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@genehub/proto": fileURLToPath(new URL("../proto/bindings/index.ts", import.meta.url)),
    },
  },
  // Relative so the same build works served from a Hub path, from a Tauri
  // `asset://` URL and from a Capacitor bundle without three configurations.
  base: "./",
  build: { outDir: "dist", sourcemap: true },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
