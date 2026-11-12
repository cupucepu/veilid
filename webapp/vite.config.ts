import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages project site: served under /veilid/
  base: "/veilid/",
  server: {
    port: 5173,
    // The demo engine reuses the contract simulator one level up.
    fs: { allow: [".."] },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
