import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        sw: "src/sw.ts",
      },
      output: {
        entryFileNames: (chunk) => {
          return chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js";
        },
      },
    },
  },
});
