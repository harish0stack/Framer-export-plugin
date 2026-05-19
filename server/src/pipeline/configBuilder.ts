import type { ComponentEntry } from "./crawler.js"

/**
 * Builds the unframer.config.json for the react-app.
 *
 * IMPORTANT — Two Framer architectures:
 *
 * OLD (Vite/Rollup — pre-2024):
 *   Each component → own CDN file: /modules/xxx.js  → exports `default` = the component
 *   unframer.config.json works perfectly with these.
 *
 * NEW (Rolldown — 2024+):
 *   All components bundled into: /sites/<hash>/page.mjs → exports `default` = FULL PAGE (not a component!)
 *   unframer.config.json CANNOT use these URLs — esbuild fails with "No matching export for 'default'"
 *   For these projects, server-side bundling is required (see bundler.ts).
 *
 * This function ONLY includes old-style /modules/ URLs in the config.
 * Rolldown page-chunk URLs are excluded to prevent the esbuild error.
 */
export function buildUnframerConfig(
  projectId: string,
  components: Record<string, string>,   // name → URL (may include Rolldown URLs we must filter)
  siteBase: string = "",
  pageChunkUrls: string[] = [],
): string {
  // Filter: only include old-style standalone module URLs
  // Rolldown URLs pattern: framerusercontent.com/sites/<hash>/<file>.mjs
  const moduleOnlyComponents: Record<string, string> = {}
  for (const [name, url] of Object.entries(components)) {
    if (url.includes("framerusercontent.com/modules/") && url.endsWith(".js")) {
      // Old-style standalone module URL — safe to use with unframer
      moduleOnlyComponents[name] = url
    }
    // Rolldown page chunk URLs (sites/*.mjs) are intentionally excluded here
    // because they don't export individual components as default
  }

  const hasModuleComponents = Object.keys(moduleOnlyComponents).length > 0

  const config: Record<string, unknown> = {
    $schema: "https://unframer-schema.vercel.app/schema.json",
    outDir: "./src/framer",
  }

  if (hasModuleComponents) {
    config.components = moduleOnlyComponents
  }

  // Metadata for reference (not used by unframer CLI)
  if (siteBase) config._siteBase = siteBase
  if (pageChunkUrls.length > 0) config._pageChunks = pageChunkUrls

  return JSON.stringify(config, null, 2)
}

/**
 * Returns the setup command shown in the README.
 *
 * For Rolldown projects (no standalone module URLs):
 *   The components are pre-bundled by our server into src/framer/ directly.
 *   The user just runs: npm install && npm run dev
 *
 * For old-style projects (has /modules/ URLs):
 *   The user runs: npm install && npx unframer && npm run dev
 */
export function buildSetupInstructions(
  projectId: string,
  components: Record<string, string>,
  hasPreBundledComponents: boolean = false,
): { setupCommand: string; explanation: string; isPreBundled: boolean } {
  // Check if any old-style module URLs exist
  const moduleUrls = Object.values(components).filter(u =>
    u.includes("framerusercontent.com/modules/") && u.endsWith(".js")
  )

  if (hasPreBundledComponents) {
    return {
      setupCommand: "npm install",
      explanation: "Components are pre-bundled by the exporter — no npx unframer needed!",
      isPreBundled: true,
    }
  }

  if (moduleUrls.length > 0) {
    return {
      setupCommand: "npx unframer",
      explanation: `Uses unframer.config.json with ${moduleUrls.length} standalone component URL(s)`,
      isPreBundled: false,
    }
  }

  return {
    setupCommand: `npx unframer ${projectId}`,
    explanation: "Framer project uses new Rolldown bundling — requires unframer.co subscription for auto-discovery",
    isPreBundled: false,
  }
}
