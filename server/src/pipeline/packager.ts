import archiver from "archiver"
import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import type { CrawlResult } from "./crawler.js"
import type { ProcessedResult } from "./processor.js"

/**
 * Packages the full export into a ZIP with two top-level directories:
 *
 * framer-export.zip
 * ├── site/              ← Static site (cleaned HTML, assets, CSS) — deploy to Netlify etc.
 * │   ├── index.html
 * │   ├── <page>.html
 * │   ├── assets/        ← All images and fonts downloaded from framerusercontent.com
 * │   └── styles.css
 * └── react-app/         ← React project — run `npm run setup` then `npm run dev`
 *     ├── src/
 *     │   ├── App.tsx    ← Auto-generated with correct layout
 *     │   ├── main.tsx
 *     │   └── framer/    ← Populated by `npx unframer`
 *     ├── unframer.config.json   ← Component CDN URLs for unframer
 *     ├── package.json
 *     ├── vite.config.ts
 *     └── README.md
 */
export async function packageZip(
  jobDir: string,
  crawl: CrawlResult,
  processed: ProcessedResult,
  unframerConfig: string,
  appScaffold: string,
  manifest: any,
  framerOutDir: string = "",   // abs path to pre-bundled framer/ dir (may be empty)
  preBundledNames: string[] = [],
): Promise<void> {
  const zipPath = path.join(jobDir, "export.zip")
  const output  = fs.createWriteStream(zipPath)
  const archive = archiver("zip", { zlib: { level: 9 } })

  // Read pre-bundled framer files BEFORE entering the non-async Promise callback
  let framerFiles: string[] = []
  if (framerOutDir) {
    try { framerFiles = await fsp.readdir(framerOutDir) } catch (_) {}
  }

  await new Promise<void>((resolve, reject) => {
    output.on("close", resolve)
    archive.on("error", reject)
    archive.pipe(output)

    // ── site/ ─────────────────────────────────────────────────────────────
    for (const page of processed.pages) {
      const name = page.slug === "index" ? "index.html" : `${page.slug}.html`
      archive.append(page.html, { name: `site/${name}` })
    }
    archive.append(processed.globalCss, { name: "site/styles.css" })

    // All downloaded assets (images + fonts) into site/assets/
    for (const asset of crawl.assets) {
      if (fs.existsSync(asset.localPath)) {
        archive.file(asset.localPath, { name: `site/${asset.relativePath}` })
      }
    }
    // Also include processed assets
    for (const asset of processed.assets) {
      if (fs.existsSync(asset.localPath) && !crawl.assets.find(a => a.localPath === asset.localPath)) {
        archive.file(asset.localPath, { name: `site/${asset.relativePath}` })
      }
    }

    // ── react-app/ ────────────────────────────────────────────────────────
    archive.append(appScaffold, { name: "react-app/src/App.tsx" })
    archive.append(buildMainTsx(), { name: "react-app/src/main.tsx" })
    archive.append(unframerConfig, { name: "react-app/unframer.config.json" })
    archive.append(buildReactPackageJson(manifest.projectName), { name: "react-app/package.json" })
    archive.append(buildViteConfig(), { name: "react-app/vite.config.ts" })
    archive.append(buildTsConfig(), { name: "react-app/tsconfig.json" })
    archive.append(buildReactReadme(manifest, crawl, preBundledNames), { name: "react-app/README.md" })
    archive.append(buildIndexHtml(manifest.projectName), { name: "react-app/index.html" })

    // ── Pre-bundled framer/ components ─────────────────────────────────────
    if (framerFiles.length > 0) {
      for (const file of framerFiles) {
        const absPath = path.join(framerOutDir, file)
        if (fs.existsSync(absPath)) {
          archive.file(absPath, { name: `react-app/src/framer/${file}` })
        }
      }
    } else {
      // Placeholder so user knows where unframer should write
      archive.append("", { name: "react-app/src/framer/.gitkeep" })
    }

    // ── assets in react-app/public/ ───────────────────────────────────────
    for (const asset of crawl.assets) {
      if (asset.type === "image" && fs.existsSync(asset.localPath)) {
        archive.file(asset.localPath, { name: `react-app/public/${asset.relativePath}` })
      }
    }

    // ── manifest.json at root ─────────────────────────────────────────────
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" })
    archive.append(buildRootReadme(manifest, crawl, processed), { name: "README.md" })

    archive.finalize()

  })
}

// ─── Scaffold file generators ─────────────────────────────────────────────────

function buildMainTsx(): string {
  return `import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"

createRoot(document.getElementById("root")!).render(<App />)
`
}

function buildReactPackageJson(projectName: string): string {
  const name = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-")
  return JSON.stringify({
    name,
    private: true,
    version: "0.0.1",
    type: "module",
    scripts: {
      "dev": "vite",
      "build": "vite build",
      "preview": "vite preview",
    },
    dependencies: {
      "react": "^19.0.0",
      "react-dom": "^19.0.0",
      "unframer": "latest",
      "framer-motion": "npm:unframer",
    },
    devDependencies: {
      "@types/react": "^19.0.0",
      "@types/react-dom": "^19.0.0",
      // SWC-based plugin: no 500KB Babel deoptimization limit, 20x faster transforms
      "@vitejs/plugin-react-swc": "^3.7.0",
      "typescript": "^5.5.0",
      "vite": "^5.4.0",
    },
  }, null, 2)
}

function buildViteConfig(): string {
  return `import { defineConfig } from "vite"
// Using SWC plugin — no 500KB Babel deoptimization limit, ~20x faster transforms
import react from "@vitejs/plugin-react-swc"

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Pre-bundle these shared deps so Vite doesn't re-process them on every request
    include: ["react", "react-dom", "unframer"],
    // Exclude our pre-bundled Framer files — they're already ESM, let Vite serve directly
    exclude: [],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        // Preserve the shared _framerBundle — don't inline it into every chunk
        manualChunks: (id) => {
          if (id.includes("_framerBundle")) return "framer-bundle"
          if (id.includes("node_modules/unframer")) return "unframer"
          if (id.includes("node_modules/react")) return "react"
        },
      },
    },
  },
})
`
}

function buildTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      useDefineForClassFields: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      isolatedModules: true,
      moduleDetection: "force",
      noEmit: true,
      jsx: "react-jsx",
      strict: true,
    },
    include: ["src"],
  }, null, 2)
}

function buildIndexHtml(projectName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
}

function buildReactReadme(manifest: any, crawl: CrawlResult, preBundledNames: string[] = []): string {
  const preBundledSet = new Set(preBundledNames)
  const componentCount = crawl.componentEntries.length + Object.keys(crawl.componentUrls).length
  const projectId = manifest.projectId ?? ""
  const hasPreBundled = preBundledNames.length > 0

  const setupCmd = hasPreBundled
    ? "npm install"
    : componentCount > 0 ? "npx unframer" : `npx unframer ${projectId}`

  const componentLines = crawl.componentEntries.length > 0
    ? crawl.componentEntries.map(e =>
        `- **${e.name}** ${preBundledSet.has(e.name) ? "✓ pre-bundled" : "—"} \`${e.chunkUrl.split("/").pop()}\``)
      .join("\n")
    : (manifest.rawEntries ?? []).map((e: any) => `- **${e.name}**`).join("\n")

  return `# ${manifest.projectName} — React App

Auto-generated by **Framer Auto Export** on ${new Date().toLocaleDateString()}.

## Quick Start

\`\`\`bash
${hasPreBundled
  ? "npm install\nnpm run dev"
  : `npm install\n${setupCmd}\nnpm run dev`}
\`\`\`

## How it works

${hasPreBundled
  ? `1. \`npm install\` — installs React, Vite, and unframer runtime
2. \`npm run dev\` — starts the Vite dev server at http://localhost:5173
   - **${preBundledNames.length} components are pre-bundled** in \`src/framer/\` (no \`npx unframer\` needed!)`
  : `1. \`npm install\` — installs React, Vite, and unframer
2. \`${setupCmd}\` — downloads all Framer components into \`src/framer/\`
3. \`npm run dev\` — starts the Vite dev server at http://localhost:5173`}

## Discovery Results

| Metric | Count |
|--------|-------|
| Pages crawled | ${crawl.pages.length} |
| Components found | ${componentCount} |
| Pre-bundled by server | ${preBundledNames.length} |
| Images downloaded | ${crawl.assets.filter(a => a.type === "image").length} |
| Fonts downloaded | ${crawl.assets.filter(a => a.type === "font").length} |

## Components (${(manifest.rawEntries ?? []).length} on canvas)

${componentLines}

## Site Info

- **Site Base:** \`${crawl.siteBase || "unknown"}\`
- **Project ID:** \`${projectId}\`
- **Generated:** ${manifest.generatedAt}
`
}

function buildRootReadme(manifest: any, crawl: CrawlResult, processed: ProcessedResult): string {
  return `# Framer Export — ${manifest.projectName}

Generated: ${manifest.generatedAt}

## Contents

| Folder | Description |
|--------|-------------|
| \`site/\` | Static HTML site — deploy directly to Netlify, Vercel static, or GitHub Pages |
| \`react-app/\` | React project — run \`npm run setup\` then \`npm run dev\` |

## Stats

- Pages crawled: **${crawl.pages.length}**
- Images downloaded: **${crawl.assets.filter(a => a.type === "image").length}**
- Fonts downloaded: **${crawl.assets.filter(a => a.type === "font").length}**
- Components discovered: **${crawl.componentEntries.length + Object.keys(crawl.componentUrls).length}**
- Site architecture: **${crawl.siteBase ? "Rolldown (new)" : "Vite/Rollup modules (legacy)"}**

## Component URLs

${Object.entries({ ...crawl.componentUrls, ...Object.fromEntries(crawl.componentEntries.map(e => [e.name, e.chunkUrl])) })
  .map(([name, url]) => `- **${name}**: \`${url.split("/").pop()}\``)
  .join("\n") || "No components resolved"}
`
}
