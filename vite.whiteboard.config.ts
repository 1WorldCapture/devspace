import { cpSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const outDir = resolve(__dirname, "dist/whiteboard");

// The whiteboard canvas page DevSpace.app shows in its floating window,
// served under /desktop/whiteboard. Excalidraw's fonts are copied next to it
// so the page never loads them from a CDN.
const excalidrawFonts = resolve(
  dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")),
  "fonts",
);

export default defineConfig({
  root: resolve(__dirname, "src/ui/whiteboard"),
  plugins: [
    react(),
    {
      name: "copy-excalidraw-fonts",
      closeBundle() {
        cpSync(excalidrawFonts, resolve(outDir, "fonts"), { recursive: true });
      },
    },
  ],
  base: "/desktop/whiteboard/",
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
