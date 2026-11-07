import { defineConfig } from "vite";
import { resolve } from "node:path";

// Content scripts can't be ES modules, so content.js is built separately as one self-contained IIFE.
export default defineConfig({
  resolve: { alias: { "~panel": resolve(__dirname, "../panel/src"), "~fixtures": resolve(__dirname, "../fixtures") } },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    lib: { entry: resolve(__dirname, "src/content.ts"), formats: ["iife"], name: "SmallPrintContent", fileName: () => "content.js" },
  },
});
