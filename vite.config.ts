import { defineConfig } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

function injectServiceWorkerShellManifest() {
  return {
    name: "inject-service-worker-shell-manifest",
    closeBundle() {
      const distDir = join(process.cwd(), "dist");
      const indexPath = join(distDir, "index.html");
      const swPath = join(distDir, "sw.js");
      const indexHtml = readFileSync(indexPath, "utf-8");
      const assetUrls = new Set<string>(["/index.html", "/"]);
      const attrPattern = /\s(?:src|href)=["']([^"']+)["']/g;
      let match: RegExpExecArray | null;

      while ((match = attrPattern.exec(indexHtml)) !== null) {
        const rawUrl = match[1];
        if (
          !rawUrl ||
          rawUrl.startsWith("http:") ||
          rawUrl.startsWith("https:") ||
          rawUrl.startsWith("data:")
        ) {
          continue;
        }
        const url = new URL(rawUrl, "https://example.invalid/");
        if (url.pathname.startsWith("/assets/")) {
          assetUrls.add(url.pathname);
        }
      }

      const buildId = createHash("sha256")
        .update(indexHtml)
        .update([...assetUrls].sort().join("\n"))
        .digest("hex")
        .slice(0, 16);

      const sw = readFileSync(swPath, "utf-8")
        .replaceAll("__BUILD_ID__", JSON.stringify(buildId))
        .replaceAll("__SHELL_MANIFEST__", JSON.stringify([...assetUrls].sort()));

      writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  plugins: [injectServiceWorkerShellManifest()],
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
