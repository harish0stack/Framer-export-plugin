import { chromium } from "playwright"
import path from "path"
import fs from "fs/promises"

export interface PageResult {
  url: string; slug: string; html: string; title: string
  scripts: string[]; styles: string[]
}
export interface AssetEntry {
  url: string; localPath: string; relativePath: string
  type: "image" | "font" | "script" | "style" | "other"
}

/** A component CDN URL — either a standalone /modules/*.js OR a bundled page .mjs */
export interface ComponentEntry {
  name: string          // Display name matched from canvas
  chunkUrl: string      // The .mjs URL that contains this component
  siteBase: string      // Base URL of the sites/<hash>/ folder
  isBundled: boolean    // true = new Rolldown bundle; false = old /modules/ URL
}

export interface CrawlResult {
  rootUrl: string
  siteBase: string                         // https://framerusercontent.com/sites/<hash>/
  pageChunkUrls: string[]                  // all *.mjs page chunks found
  pages: PageResult[]
  assets: AssetEntry[]
  componentUrls: Record<string, string>    // legacy: componentName → standalone module URL
  componentEntries: ComponentEntry[]       // new: rich component info
  allScripts: string[]; allStyles: string[]
}

// ── Patterns ──────────────────────────────────────────────────────────────────
const FRAMER_MODULE_RE = /https:\/\/framerusercontent\.com\/modules\/[^\s"'<>\\]+\.js(?:\?[^\s"'<>]*)?/g
const SITES_SCRIPT_RE = /https:\/\/framerusercontent\.com\/sites\/([A-Za-z0-9_-]+)\/([^\s"'<>\\]+\.mjs)/g
const IMAGE_RE = /https:\/\/framerusercontent\.com\/images\/([^\s"'`\\)?&]+)/g
const FONT_RE  = /https:\/\/framerusercontent\.com\/assets\/([^\s"'`\\)?]+\.woff2?)/g

export async function crawlSite(
  rootUrl: string,
  jobDir: string,
  knownNames: string[] = []
): Promise<CrawlResult> {
  const assetsDir = path.join(jobDir, "assets")
  await fs.mkdir(assetsDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    viewport: { width: 1440, height: 900 },
    bypassCSP: true,
  })

  // ── Network capture ────────────────────────────────────────────────────────
  const capturedModuleUrls = new Set<string>()  // old /modules/ URLs
  const capturedSiteChunks = new Set<string>()  // new /sites/<hash>/*.mjs
  const imageUrls          = new Set<string>()
  const fontUrls           = new Set<string>()
  let detectedSiteBase     = ""

  await ctx.route("**/*", async route => {
    const u = route.request().url()
    if (u.includes("framerusercontent.com/modules/") && u.includes(".js")) {
      capturedModuleUrls.add(cleanUrl(u))
    }
    if (u.includes("framerusercontent.com/sites/") && u.includes(".mjs")) {
      capturedSiteChunks.add(u.split("?")[0])
      // Detect site base
      const m = u.match(/https:\/\/framerusercontent\.com\/sites\/([A-Za-z0-9_-]+)\//)
      if (m && !detectedSiteBase) detectedSiteBase = `https://framerusercontent.com/sites/${m[1]}/`
    }
    if (/\.(jpe?g|png|gif|webp|svg|avif)(\?|$)/i.test(u) && u.includes("framerusercontent.com")) {
      imageUrls.add(u.split("?")[0])
    }
    if (/\.woff2?(\?|$)/i.test(u) && u.includes("framerusercontent.com")) {
      fontUrls.add(u.split("?")[0])
    }
    await route.continue()
  })

  // ── Page crawl ────────────────────────────────────────────────────────────
  const origin  = new URL(rootUrl).origin
  const visited = new Set<string>()
  const queue   = [normalise(rootUrl)]
  const pages: PageResult[] = []

  while (queue.length > 0) {
    const url = queue.shift()!
    if (visited.has(url)) continue
    visited.add(url)
    console.log(`  [CRAWL] ${url}`)

    const page = await ctx.newPage()
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 })
      await page.waitForTimeout(2500)
      await autoScroll(page)
      await page.waitForTimeout(2000)

      const html  = await page.content()
      const title = await page.title()
      const slug  = toSlug(url, rootUrl)

      // Parse HTML for module URLs
      for (const mu of html.match(FRAMER_MODULE_RE) ?? []) capturedModuleUrls.add(cleanUrl(mu))

      // Parse HTML for sites/ script tags
      for (const sm of html.matchAll(SITES_SCRIPT_RE)) {
        const siteUrl = sm[0].split("?")[0]
        capturedSiteChunks.add(siteUrl)
        if (!detectedSiteBase) {
          detectedSiteBase = `https://framerusercontent.com/sites/${sm[1]}/`
        }
      }

      // Parse images / fonts from HTML source
      for (const im of html.matchAll(IMAGE_RE)) imageUrls.add(`https://framerusercontent.com/images/${im[1]}`)
      for (const fo of html.matchAll(FONT_RE))  fontUrls.add(`https://framerusercontent.com/assets/${fo[1]}`)

      // Script src tags
      const scriptSrcs = await page.$$eval("script[src]", els => els.map(e => (e as HTMLScriptElement).src))
      for (const s of scriptSrcs) {
        if (s.includes("framerusercontent.com/modules/")) capturedModuleUrls.add(cleanUrl(s))
        if (s.includes("framerusercontent.com/sites/") && s.includes(".mjs")) {
          capturedSiteChunks.add(s.split("?")[0])
        }
      }

      const styles = await page.$$eval('link[rel="stylesheet"]', els => els.map(e => (e as HTMLLinkElement).href))
      pages.push({ url, slug, html, title, scripts: scriptSrcs.filter(s => s.includes("framer")), styles })

      // Discover links
      const hrefs = await page.$$eval("a[href]", els => els.map(e => (e as HTMLAnchorElement).href))
      for (const href of hrefs) {
        try {
          const u = new URL(href)
          if (u.origin === origin && !visited.has(u.href) && !u.hash &&
              !u.pathname.match(/\.(pdf|zip|jpg|png|svg)$/i))
            queue.push(u.href)
        } catch (_) {}
      }
    } catch (err) {
      console.error(`  [CRAWL ERROR] ${url}:`, err)
    } finally {
      await page.close()
    }
  }

  // ── Deep-fetch page chunks to extract assets + component names ──────────
  console.log(`\n  [CHUNKS] Found ${capturedSiteChunks.size} site chunk(s), ${capturedModuleUrls.size} module URL(s)`)
  const resolvePage = await ctx.newPage()

  // Filter to only page chunks (not shared libs like react.mjs / motion.mjs / framer.mjs)
  const SHARED_LIB_PATTERNS = ["rolldown-runtime", "react.", "motion.", "framer.", "shared-lib"]
  const pageChunkUrls = [...capturedSiteChunks].filter(u => {
    const filename = u.split("/").pop() || ""
    return !SHARED_LIB_PATTERNS.some(p => filename.startsWith(p))
  })

  const componentEntries: ComponentEntry[] = []
  const componentUrls: Record<string, string> = {}

  // A) Process new-style bundled page chunks
  for (const chunkUrl of pageChunkUrls) {
    console.log(`  [CHUNK] Scanning ${chunkUrl.split("/").pop()}`)
    try {
      const resp = await resolvePage.context().request.get(chunkUrl, { timeout: 30_000 })
      if (!resp.ok()) continue
      const src = await resp.text()

      // Extract images and fonts from the chunk
      for (const im of src.matchAll(IMAGE_RE)) {
        imageUrls.add(`https://framerusercontent.com/images/${im[1]}`)
      }
      for (const fo of src.matchAll(FONT_RE)) {
        fontUrls.add(`https://framerusercontent.com/assets/${fo[1]}`)
      }

      // Extract component names from data-framer-name attributes and displayName
      const framerNames = new Set<string>()
      for (const m of src.matchAll(/["'`]data-framer-name["'`]\s*:\s*["'`]([^"'`]+)["'`]/g)) {
        framerNames.add(m[1])
      }
      for (const m of src.matchAll(/displayName\s*=\s*["'`]([^"'`]+)["'`]/g)) {
        framerNames.add(m[1])
      }
      for (const m of src.matchAll(/displayName\s*:\s*["'`]([^"'`]+)["'`]/g)) {
        framerNames.add(m[1])
      }
      // Also look for __name(fn, "ComponentName") pattern
      for (const m of src.matchAll(/__name\s*\(\s*\w+\s*,\s*["'`]([A-Z][A-Za-z0-9/_ -]+)["'`]/g)) {
        framerNames.add(m[1])
      }

      console.log(`    Found ${framerNames.size} component names in chunk`)

      // Match found names against canvas known names
      const siteBase = detectedSiteBase || chunkUrl.replace(/[^/]+\.mjs$/, "")
      for (const name of framerNames) {
        const matched = matchToKnown(name, knownNames)
        const finalName = matched || name
        if (finalName && /^[A-Z]/.test(finalName) && !isGeneric(finalName)) {
          const existing = componentEntries.find(e => e.name === finalName)
          if (!existing) {
            componentEntries.push({ name: finalName, chunkUrl, siteBase, isBundled: true })
          }
        }
      }

    } catch (e: any) {
      console.error(`    Error scanning chunk: ${e.message}`)
    }
  }

  // B) Process old-style /modules/ URLs
  console.log(`\n  [MODULES] Resolving ${capturedModuleUrls.size} standalone module URLs`)
  for (const moduleUrl of capturedModuleUrls) {
    const name = await resolveModuleName(resolvePage, moduleUrl, knownNames)
    if (name && !componentUrls[name]) {
      componentUrls[name] = moduleUrl
      console.log(`  [MAP] "${name}" → ${moduleUrl}`)
    }
  }

  // ── Download assets ───────────────────────────────────────────────────────
  const assets: AssetEntry[] = []
  const allAssetUrls = [...imageUrls, ...fontUrls]
  console.log(`\n  [ASSETS] Downloading ${allAssetUrls.length} assets (${imageUrls.size} images, ${fontUrls.size} fonts)`)

  for (const assetUrl of allAssetUrls) {
    const entry = await downloadAsset(resolvePage, assetUrl, assetsDir)
    if (entry) assets.push(entry)
  }

  await resolvePage.close()
  await browser.close()

  // De-duplicate component entries — prefer canvas name matches
  const deduped = deduplicateComponents(componentEntries, knownNames)
  console.log(`\n  ✓ Crawl done: ${pages.length} page(s), ${deduped.length} component(s), ${assets.length} asset(s)`)
  console.log(`  Component names: ${deduped.map(c => c.name).join(", ")}`)

  return {
    rootUrl, siteBase: detectedSiteBase,
    pageChunkUrls, pages, assets,
    componentUrls,
    componentEntries: deduped,
    allScripts: [...new Set(pages.flatMap(p => p.scripts))],
    allStyles:  [...new Set(pages.flatMap(p => p.styles))],
  }
}

// ─── Component Name Resolution ────────────────────────────────────────────────
function matchToKnown(candidate: string, knownNames: string[]): string | null {
  if (knownNames.length === 0) return null
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
  const nc = norm(candidate)
  // Exact match first
  for (const k of knownNames) {
    if (norm(k) === nc) return k
  }
  // Substring match
  for (const k of knownNames) {
    const nk = norm(k)
    if (nc === nk || nc.includes(nk) || nk.includes(nc)) return k
  }
  return null
}

function isGeneric(name: string): boolean {
  const GENERIC = new Set(["React", "Component", "Fragment", "Children", "Element",
    "StrictMode", "Suspense", "Provider", "Consumer", "Context", "Ref",
    "createContext", "forwardRef", "memo", "useEffect", "useState",
    "Content", "Container", "Wrapper", "Inner", "Outer", "Root"])
  return GENERIC.has(name) || name.length <= 2
}

function deduplicateComponents(entries: ComponentEntry[], knownNames: string[]): ComponentEntry[] {
  const byName = new Map<string, ComponentEntry>()

  if (knownNames.length > 0) {
    // PRIORITY 1: Canvas-matched components (exact match to knownNames)
    // Build a normalized lookup of known canvas names
    const knownNormMap = new Map(knownNames.map(k => [k.toLowerCase().replace(/[^a-z0-9]/g, ""), k]))

    for (const e of entries) {
      const norm = e.name.toLowerCase().replace(/[^a-z0-9]/g, "")
      if (knownNormMap.has(norm)) {
        // Use the official canvas name (user-readable), not the JS extracted name
        const canonicalName = knownNormMap.get(norm)!
        if (!byName.has(canonicalName)) {
          byName.set(canonicalName, { ...e, name: canonicalName })
        }
      }
    }

    // PRIORITY 2: Substring-matched canvas components (e.g. "FAQ Item" matched to "Helper/FAQ Item")
    for (const e of entries) {
      for (const [knownNorm, knownName] of knownNormMap) {
        if (!byName.has(knownName)) {
          const norm = e.name.toLowerCase().replace(/[^a-z0-9]/g, "")
          if (norm.includes(knownNorm) || knownNorm.includes(norm)) {
            byName.set(knownName, { ...e, name: knownName })
          }
        }
      }
    }

    // PRIORITY 3: If we still have unmatched canvas components, include raw entries for them
    // (so the App.tsx at least has placeholders and the URL is in unframer.config.json)
    // Note: unmatched canvas components get included in the TODO comments in App.tsx
  } else {
    // No canvas names known — include all non-generic PascalCase names
    for (const e of entries) {
      if (!byName.has(e.name) && !isGeneric(e.name) && /^[A-Z]/.test(e.name)) {
        byName.set(e.name, e)
      }
    }
  }

  return [...byName.values()]
}

// ─── Old-style module URL resolution ──────────────────────────────────────────
async function resolveModuleName(
  page: import("playwright").Page,
  moduleUrl: string,
  knownNames: string[]
): Promise<string | null> {
  try {
    const response = await page.context().request.get(moduleUrl, {
      headers: { "Accept": "*/*", "Origin": "https://framerusercontent.com" },
      timeout: 15_000,
    })
    if (!response.ok()) return null
    const src = await response.text()
    const candidates: string[] = []
    for (const m of src.matchAll(/\.displayName\s*=\s*["']([A-Za-z][A-Za-z0-9 _/-]*)['"]/g)) candidates.push(m[1])
    for (const m of src.matchAll(/displayName:\s*["']([A-Za-z][A-Za-z0-9 _/-]*)['"]/g)) candidates.push(m[1])
    for (const m of src.matchAll(/__name\s*\(\s*\w+\s*,\s*["']([A-Za-z][A-Za-z0-9 _/-]*)['"]/g)) candidates.push(m[1])
    if (candidates.length === 0) return null
    if (knownNames.length > 0) {
      for (const c of candidates) {
        const matched = matchToKnown(c, knownNames)
        if (matched) return matched
      }
    }
    for (const c of candidates) {
      if (/^[A-Z]/.test(c) && !isGeneric(c)) return c.replace(/[^A-Za-z0-9]/g, "")
    }
    return null
  } catch { return null }
}

// ─── Asset Download ───────────────────────────────────────────────────────────
async function downloadAsset(
  page: import("playwright").Page,
  assetUrl: string,
  dir: string
): Promise<AssetEntry | null> {
  try {
    const response = await page.context().request.get(assetUrl, { timeout: 15_000 })
    if (!response.ok()) return null
    const buf = await response.body()
    const u   = new URL(assetUrl)
    const ext = path.extname(u.pathname) || ".bin"
    // Use last path segment as filename (preserves framerusercontent hash names)
    const basename = path.basename(u.pathname) || "asset"
    const local = path.join(dir, basename)
    await fs.writeFile(local, buf)
    const type: AssetEntry["type"] = /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(ext) ? "image"
                                   : /\.woff2?$/i.test(ext) ? "font" : "other"
    return { url: assetUrl, localPath: local, relativePath: `assets/${basename}`, type }
  } catch { return null }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function autoScroll(page: import("playwright").Page) {
  await page.evaluate(async () => {
    await new Promise<void>(resolve => {
      let dist = 0
      const step = 400
      const timer = setInterval(() => {
        window.scrollBy(0, step)
        dist += step
        if (dist >= document.body.scrollHeight) { clearInterval(timer); window.scrollTo(0, 0); resolve() }
      }, 80)
    })
  }).catch(() => {})
  await page.waitForTimeout(1000)
}
function normalise(url: string) { const u = new URL(url); return `${u.origin}${u.pathname}` }
function toSlug(url: string, root: string) {
  const u = new URL(url), r = new URL(root)
  const rel = u.pathname.replace(r.pathname, "").replace(/^\/|\/$/, "")
  return rel === "" ? "index" : rel.replace(/\//g, "-")
}
function cleanUrl(url: string) { return url.split("?")[0] }
