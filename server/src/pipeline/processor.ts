import * as cheerio from "cheerio"
import path from "path"
import fs from "fs/promises"
import type { CrawlResult, AssetEntry } from "./crawler.js"

export interface ProcessedPage {
  slug: string; title: string; html: string; usedComponents: string[]
}
export interface ProcessedResult {
  pages: ProcessedPage[]; globalCss: string; assets: AssetEntry[]
}

/**
 * 12-Step DOM Processing Pipeline
 * Converts Framer's React-rendered HTML into clean, self-hostable static HTML
 */
export async function processDOM(crawl: CrawlResult, jobDir: string): Promise<ProcessedResult> {
  const cssDir = path.join(jobDir, "styles")
  await fs.mkdir(cssDir, { recursive: true })

  const processedPages: ProcessedPage[] = []
  const globalCssChunks: string[] = []

  for (const page of crawl.pages) {
    const result = processPage(page.html, page.slug, crawl)
    processedPages.push({
      slug: page.slug, title: page.title,
      html: result.html, usedComponents: result.usedComponents,
    })
    if (result.extractedCss) globalCssChunks.push(`/* ${page.slug} */\n${result.extractedCss}`)
  }

  // Rewrite asset URLs in all pages
  const assetMap = new Map(crawl.assets.map(a => [a.url, a.relativePath]))
  for (const p of processedPages) {
    p.html = rewriteAssetUrls(p.html, assetMap)
  }

  const globalCss = buildGlobalCss(globalCssChunks)
  await fs.writeFile(path.join(jobDir, "styles.css"), globalCss)

  return { pages: processedPages, globalCss, assets: crawl.assets }
}

// ─── Per-page processing (12 steps) ──────────────────────────────────────────
function processPage(html: string, slug: string, crawl: CrawlResult) {
  const $ = cheerio.load(html)

  // STEP 1 — Remove Framer runtime bootstrap scripts
  $('script').each((_, el) => {
    const src     = $(el).attr("src") ?? ""
    const content = $(el).html() ?? ""
    if (
      src.includes("framer.com") || src.includes("events.framer.com") ||
      content.includes("__framer") || content.includes("FramerBridge") ||
      content.includes("window.__framer") || content.includes("FRAMER_") ||
      content.includes("framer-motion-config")
    ) {
      $(el).remove()
    }
  })

  // STEP 2 — Remove Framer analytics / tracking
  $('script, img, iframe').each((_, el) => {
    const src = $(el).attr("src") ?? $(el).attr("data-src") ?? ""
    if (src.includes("events.framer.com") || src.includes("framer-analytics")) $(el).remove()
  })

  // STEP 3 — Remove Framer-specific meta tags
  $('meta[name^="framer"]').remove()
  $('link[href*="framer.com"]').remove()

  // STEP 4 — Fix responsive variants
  // Framer renders desktop + tablet + mobile simultaneously; strip hidden ones
  $('[class*="hidden-"]').each((_, el) => {
    const cls = $(el).attr("class") ?? ""
    // Keep desktop, remove tablet/mobile hidden variants aggressively
    if (cls.includes("hidden-desktop") || cls.includes("framerHidden")) $(el).remove()
  })

  // STEP 5 — Extract inline <style> tags → external file
  let extractedCss = ""
  $('style').each((_, el) => {
    extractedCss += $(el).html() + "\n"
    $(el).remove()
  })

  // STEP 6 — Inject base stylesheet link + our styles.css
  $('head').append(`<link rel="stylesheet" href="./styles.css" />`)

  // STEP 7 — Fix internal links (Framer uses bare path routes)
  $('a[href]').each((_, el) => {
    const href = $(el).attr("href") ?? ""
    if (href.startsWith("/") && !href.startsWith("//") && !href.includes(".")) {
      const page = href === "/" ? "index" : href.replace(/^\//, "").replace(/\//g, "-")
      $(el).attr("href", `./${page}.html`)
    }
  })

  // STEP 8 — Rewrite CDN image srcs to relative paths (done post-loop)
  // (handled in rewriteAssetUrls)

  // STEP 9 — Add intersection observer polyfill for scroll reveals
  $('body').append(`
<script>
if (!('IntersectionObserver' in window)) {
  var s = document.createElement('script');
  s.src = 'https://polyfill.io/v3/polyfill.min.js?features=IntersectionObserver';
  document.head.appendChild(s);
}
</script>`)

  // STEP 10 — Remove data-framer-* attributes (reduce noise, keep layout)
  $('[data-framer-component-type]').removeAttr("data-framer-component-type")
  $('[data-framer-name]').removeAttr("data-framer-name")

  // STEP 11 — Detect which component names appear in the HTML
  // (used to know which unframer components to render)
  const usedComponents: string[] = []
  const allComponentNames = [
    ...Object.keys(crawl.componentUrls),
    ...(crawl.componentEntries ?? []).map(e => e.name),
  ]
  for (const name of [...new Set(allComponentNames)]) {
    if (html.includes(name)) usedComponents.push(name)
  }

  // STEP 12 — Clean up empty divs Framer leaves behind
  $('div:empty').filter((_, el) => {
    const cls = $(el).attr("class") ?? ""
    return cls.includes("framer") && !cls.includes("framer-page")
  }).remove()

  return { html: $.html(), extractedCss, usedComponents }
}

function rewriteAssetUrls(html: string, assetMap: Map<string, string>): string {
  for (const [originalUrl, relativePath] of assetMap) {
    html = html.split(originalUrl).join(`./${relativePath}`)
  }
  return html
}

function buildGlobalCss(chunks: string[]): string {
  return `/* Generated by Framer Auto Export */
/* Base reset */
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; }

${chunks.join("\n\n")}
`
}
