import { defineConfig } from "vite";
export default defineConfig({
  root: "public",
  build: { assetsInlineLimit: 0, outDir: "../dist", emptyOutDir: true },
});
