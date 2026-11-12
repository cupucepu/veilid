import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // The demo engine reuses the contract simulator one level up.
    fs: { allow: [".."] },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
