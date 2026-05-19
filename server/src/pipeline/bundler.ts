import { build, Plugin } from "esbuild"
import path from "path"
import fs from "fs/promises"
import type { ComponentEntry } from "./crawler.js"

/**
 * Server-side esbuild bundler for Framer Rolldown components.
 *
 * KEY ARCHITECTURE DECISION — "Bundle Once, Wrap Per Component":
 *
 * Problem with naive approach (previous version):
 *   - Bundle page chunk separately for EACH component
 *   - Result: 16 components × 5.9MB = 94MB, every file is identical except the last line
 *   - Babel deoptimizes (500KB limit), Vite startup is slow
 *
 * Correct approach:
 *   1. Bundle the Framer page chunk(s) ONCE into `_framerBundle.js`
 *      - Externalizes react, framer-motion, unframer (installed by user)
 *      - Includes all component code (NavBar, Footer, etc.) in one place
 *   2. Generate thin wrapper files per component:
 *      - `NavBar.jsx` → just wraps + re-exports default from `_framerBundle.js`
 *   3. Post-process to add @vite-ignore to template-literal dynamic imports
 *
 * Result: ~6MB total (not per file), fast Vite startup, no Babel warnings
 */

const EXTERNAL_PACKAGES = [
  "react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime",
  "framer-motion", "framer", "unframer",
]

export interface BundleComponentsOptions {
  componentEntries: ComponentEntry[]
  knownNames: string[]
  outDir: string          // abs path to react-app/src/framer/
  siteBase: string
}

export interface BundleResult {
  bundled: string[]       // component names successfully bundled
  failed: string[]
  stylesCss: string
}

export async function bundleFramerComponents(opts: BundleComponentsOptions): Promise<BundleResult> {
  const { componentEntries, outDir, siteBase } = opts
  await fs.mkdir(outDir, { recursive: true })

  if (componentEntries.length === 0) {
    await fs.writeFile(path.join(outDir, "styles.css"), buildStylesCss())
    return { bundled: [], failed: [], stylesCss: buildStylesCss() }
  }

  // ── Step 1: Collect all unique chunk URLs ──────────────────────────────────
  const uniqueChunkUrls = [...new Set(componentEntries.map(e => e.chunkUrl))]
  console.log(`  [BUNDLER] Bundling ${uniqueChunkUrls.length} unique chunk(s) for ${componentEntries.length} component(s)`)

  // ── Step 2: Build ONE shared bundle per chunk → _framerBundle_<n>.js ──────
  type BundleInfo = { file: string; hasDefault: boolean }
  const chunkToBundle = new Map<string, BundleInfo>()  // chunkUrl → bundle info
  const bundled: string[] = []
  const failed: string[] = []

  for (let i = 0; i < uniqueChunkUrls.length; i++) {
    const chunkUrl = uniqueChunkUrls[i]
    const bundleFile = `_framerBundle${i === 0 ? "" : i}.js`
    const bundlePath = path.join(outDir, bundleFile)

    console.log(`  [BUNDLER] Bundling chunk ${i + 1}/${uniqueChunkUrls.length}: ${chunkUrl.split("/").pop()}`)
    try {
      const info = await bundleChunk(chunkUrl, siteBase, bundlePath)
      chunkToBundle.set(chunkUrl, { file: bundleFile, hasDefault: info.hasDefault })
      console.log(`    ✓ → ${bundleFile} (${(await fs.stat(bundlePath)).size / 1024 | 0}KB, hasDefault=${info.hasDefault})`)
    } catch (e: any) {
      console.error(`    ✗ Chunk bundle failed: ${e.message}`)
      for (const entry of componentEntries.filter(e => e.chunkUrl === chunkUrl)) {
        failed.push(entry.name)
      }
    }
  }

  // ── Step 3: Write thin wrapper .jsx per component ─────────────────────────
  for (const entry of componentEntries) {
    const bundleInfo = chunkToBundle.get(entry.chunkUrl)
    if (!bundleInfo) continue  // chunk failed above

    try {
      const safeName = toPascalCase(entry.name)
      const wrapperPath = path.join(outDir, `${safeName}.jsx`)
      const wrapper = buildComponentWrapper(entry.name, safeName, bundleInfo.file, bundleInfo.hasDefault)
      await fs.writeFile(wrapperPath, wrapper)
      bundled.push(entry.name)
      console.log(`    ✓ Wrapper: ${safeName}.jsx (hasDefault=${bundleInfo.hasDefault})`)
    } catch (e: any) {
      console.error(`    ✗ Wrapper failed for ${entry.name}: ${e.message}`)
      failed.push(entry.name)
    }
  }

  // ── Step 4: Write styles.css ───────────────────────────────────────────────
  const stylesCss = buildStylesCss()
  await fs.writeFile(path.join(outDir, "styles.css"), stylesCss)

  return { bundled, failed, stylesCss }
}

// ─── Chunk Bundler ─────────────────────────────────────────────────────────────
async function bundleChunk(chunkUrl: string, siteBase: string, outFile: string): Promise<{ hasDefault: boolean }> {
  // Detect what the chunk actually exports (it varies by chunk type)
  const resp = await fetch(chunkUrl, { signal: AbortSignal.timeout(30_000) })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching chunk`)
  const chunkText = await resp.text()

  // Parse the final export statement — e.g. export{Ll as default, Rl as __FramerMetadata__}
  // Only look at the LAST export{} in the file (the public API statement)
  const lastExportIdx = chunkText.lastIndexOf("export{")
  const lastExportStmt = lastExportIdx >= 0 ? chunkText.slice(lastExportIdx, lastExportIdx + 300) : ""
  // True only if 'default' appears as an export alias in the statement
  const hasDefault = /\bas default[,}]/.test(lastExportStmt)

  // Build entry: only re-export what actually exists in this chunk
  const lines = ["'use client'"]
  lines.push(`export * from '${chunkUrl}'`)  // all named exports
  if (hasDefault) {
    lines.push(`export { default } from '${chunkUrl}'`)
  }
  const entryContents = lines.join("\n")


  // Extract sibling chunk URLs from the source to mark as external
  // Pattern: from './rolldown-runtime.xxx.mjs' → https://...sites/<hash>/rolldown-runtime.xxx.mjs
  const siblingPattern = /from\s*["'](\.\/((?!framer-bundle)[^"']+\.mjs))["']/g
  const siblingExternals: string[] = []
  for (const m of chunkText.matchAll(siblingPattern)) {
    const sibling = new URL(m[1], chunkUrl).toString()
    siblingExternals.push(sibling)
  }
  console.log(`    Sibling externals: ${siblingExternals.length} (${siblingExternals.map(u => u.split('/').pop()).join(', ')})`)

  const result = await build({
    stdin: {
      contents: entryContents,
      resolveDir: path.dirname(outFile),
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "esnext",
    minify: false,
    treeShaking: false,
    splitting: false,
    external: EXTERNAL_PACKAGES,
    logLevel: "silent",
    write: false,
    plugins: [
      framerHttpPlugin(siteBase, siblingExternals),
    ],
  })

  if (!result.outputFiles?.length) throw new Error("No output from esbuild")

  let code = result.outputFiles[0].text
  code = fixDynamicImports(code)

  await fs.writeFile(outFile, code)
  return { hasDefault }
}

// ─── Dynamic Import Fix ────────────────────────────────────────────────────────
/**
 * Framer's font-loading code has dynamic imports with template literals:
 *   await import(`${baseUrl}${name}.js@0.0.32`)
 * Vite cannot statically analyze these → warns about "dynamic import cannot be analyzed"
 * Fix: inject @vite-ignore comment so Vite leaves them alone at runtime.
 */
function fixDynamicImports(code: string): string {
  // Match: import(`${...}`) or import( `...${...}...` ) — any template literal import
  return code.replace(/\bimport\(\s*`/g, "import(/* @vite-ignore */ `")
}

// ─── Component Wrapper ─────────────────────────────────────────────────────────
/**
 * TWO CASES based on whether the source chunk has a default export:
 *
 * hasDefault=true (page chunks like RJwEf...mjs):
 *   → `import PageModule from './_framerBundle.js'`  — standard default import
 *
 * hasDefault=false (routing chunks like script_main.mjs):
 *   → `import * as BundleModule from './_framerBundle.js'` — namespace import (always safe)
 *   → Runtime fallback: default → getPageRoot() → named fn → placeholder
 *   This prevents Vite's "No matching export for 'default'" crash.
 */
function buildComponentWrapper(name: string, safeName: string, bundleFile: string, hasDefault: boolean): string {
  if (hasDefault) {
    return `// Auto-generated by Framer Auto Export — ${name}
// @ts-nocheck
/* eslint-disable */
import { ContextProviders } from 'unframer'
import PageModule from './${bundleFile}'

function ${safeName}(props) {
  return (
    <ContextProviders>
      <PageModule {...props} />
    </ContextProviders>
  )
}
${safeName}.displayName = '${name}'
export default ${safeName}
`
  }

  // No default export: routing/layout chunk (e.g. script_main.mjs).
  // Use namespace import (always safe) + runtime fallback chain.
  return `// Auto-generated by Framer Auto Export — ${name}
// NOTE: This component lives in a Framer routing chunk (no default export).
// Runtime fallback: default → getPageRoot() → named fn → placeholder div.
// @ts-nocheck
/* eslint-disable */
import { ContextProviders } from 'unframer'
import * as BundleModule from './${bundleFile}'

const _resolved =
  BundleModule.default ??
  (typeof BundleModule.getPageRoot === 'function' ? BundleModule.getPageRoot() : null) ??
  Object.values(BundleModule).find(v => typeof v === 'function' && /^[A-Z]/.test((v.displayName ?? v.name) ?? '')) ??
  null

function ${safeName}(props) {
  if (!_resolved) {
    return (
      <div style={{padding:'1rem',border:'1px dashed #aaa',borderRadius:8,color:'#666',fontFamily:'sans-serif',fontSize:14}}>
        <b>${name}</b>: part of Framer\u2019s page-routing layer \u2014 cannot be isolated as a standalone component.
      </div>
    )
  }
  const Comp = _resolved
  return (
    <ContextProviders>
      <Comp {...props} />
    </ContextProviders>
  )
}
${safeName}.displayName = '${name}'
export default ${safeName}
`
}

// ─── HTTP Fetch Plugin ─────────────────────────────────────────────────────────
function framerHttpPlugin(siteBase: string, extraExternals: string[] = []): Plugin {
  const cache = new Map<string, Promise<string>>()
  const externalSet = new Set(extraExternals)

  const fetchText = (url: string): Promise<string> => {
    if (!cache.has(url)) {
      cache.set(url, (async () => {
        const resp = await fetch(url, {
          headers: { "Accept": "*/*", "Origin": "https://framerusercontent.com" },
          signal: AbortSignal.timeout(30_000),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`)
        return resp.text()
      })())
    }
    return cache.get(url)!
  }

  return {
    name: "framer-http-loader",
    setup(build) {
      // Resolve absolute https:// URLs
      build.onResolve({ filter: /^https?:\/\// }, args => ({
        path: args.path, namespace: "http-url",
      }))

      // Resolve relative imports from within http-url modules
      build.onResolve({ filter: /^\./, namespace: "http-url" }, args => {
        const resolved = new URL(args.path, args.importer).toString()
        // Mark sibling CDN chunks as external to prevent them from being bundled in
        // (framer.mjs=434KB, motion.mjs=150KB, etc. — these are provided by unframer at runtime)
        if (
          externalSet.has(resolved) ||
          resolved.includes("framerusercontent.com/sites/") ||
          resolved.includes("app.framerstatic.com/") ||
          resolved.includes("framercdn.com/")
        ) {
          return { path: resolved, external: true }
        }
        return { path: resolved, namespace: "http-url" }
      })

      // Externalize npm-like bare imports from within http-url modules
      build.onResolve({ filter: /^[^./]/, namespace: "http-url" }, args => ({
        path: args.path, external: true,
      }))

      // Load http-url files by fetching
      build.onLoad({ filter: /.*/, namespace: "http-url" }, async args => {
        const contents = await fetchText(args.path)
        return { contents, loader: "js" }
      })
    },
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────
function buildStylesCss(): string {
  return `/* Generated by Framer Auto Export */
/* Required styles for Framer components */
@import "unframer/styles/reset.css";
@import "unframer/styles/framer.css";
`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toPascalCase(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _/-]/g, "")
    .split(/[\s_/-]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("") || "Component"
}
