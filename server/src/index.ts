import express from "express"
import cors from "cors"
import { randomUUID } from "crypto"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import { crawlSite } from "./pipeline/crawler.js"
import { processDOM } from "./pipeline/processor.js"
import { buildUnframerConfig, buildSetupInstructions } from "./pipeline/configBuilder.js"
import { buildAppScaffold } from "./pipeline/scaffoldBuilder.js"
import { packageZip } from "./pipeline/packager.js"
import { bundleFramerComponents } from "./pipeline/bundler.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const JOBS_DIR  = path.join(__dirname, "..", "jobs")
await fs.mkdir(JOBS_DIR, { recursive: true })

const app = express()
app.use(cors())
app.use(express.json({ limit: "20mb" }))

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() })
})

// ── POST /export ──────────────────────────────────────────────────────────────
app.post("/export", async (req, res) => {
  const { manifest, publishedUrl } = req.body as { manifest: any; publishedUrl: string }
  if (!publishedUrl?.trim()) return res.status(400).json({ error: "publishedUrl is required" })

  const jobId  = randomUUID()
  const jobDir = path.join(JOBS_DIR, jobId)
  await fs.mkdir(jobDir, { recursive: true })
  await fs.writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2))
  await writeStatus(jobDir, { stage: "pending", ts: new Date().toISOString() })

  res.json({ jobId, statusUrl: `/status/${jobId}`, downloadUrl: `/download/${jobId}` })

  runPipeline(jobId, jobDir, publishedUrl.trim(), manifest).catch(async err => {
    console.error(`[${jobId}] Fatal:`, err)
    await writeStatus(jobDir, { stage: "error", error: err.message })
  })
})

// ── GET /status/:jobId ────────────────────────────────────────────────────────
app.get("/status/:jobId", async (req, res) => {
  const file = path.join(JOBS_DIR, req.params.jobId, "status.json")
  try { res.json(JSON.parse(await fs.readFile(file, "utf8"))) }
  catch { res.status(404).json({ stage: "pending" }) }
})

// ── GET /download/:jobId ──────────────────────────────────────────────────────
app.get("/download/:jobId", async (req, res) => {
  const zip = path.join(JOBS_DIR, req.params.jobId, "export.zip")
  try {
    await fs.access(zip)
    res.setHeader("Content-Type", "application/zip")
    res.setHeader("Content-Disposition", `attachment; filename="framer-export.zip"`)
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.sendFile(path.resolve(zip))
  } catch {
    res.status(404).json({ error: "Not ready yet" })
  }
})

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function runPipeline(jobId: string, jobDir: string, publishedUrl: string, manifest: any) {
  const log = async (stage: string, detail?: string, progress?: number) => {
    console.log(`[${jobId}] ${stage}${detail ? " — " + detail : ""}`)
    await writeStatus(jobDir, { stage, detail, progress, ts: new Date().toISOString() })
  }

  await log("crawling", publishedUrl, 10)

  // Pass known component names from canvas scan — used for fuzzy matching
  const knownNames = (manifest.rawEntries ?? []).map((e: any) => e.name as string)
  const crawl = await crawlSite(publishedUrl, jobDir, knownNames)

  await log("crawling",
    `${crawl.pages.length} pages | ${crawl.componentEntries.length} components | ${crawl.assets.length} assets`,
    30)

  // ── Build component maps ──────────────────────────────────────────────────
  // mergedComponents: all discovered name→URL pairs (for reference + unframer config)
  const mergedComponents: Record<string, string> = {}
  Object.assign(mergedComponents, crawl.componentUrls)  // old-style /modules/ URLs
  for (const entry of crawl.componentEntries) {
    if (!mergedComponents[entry.name]) mergedComponents[entry.name] = entry.chunkUrl
  }
  console.log(`[${jobId}] Found ${Object.keys(mergedComponents).length} component(s):`, Object.keys(mergedComponents).join(", "))

  // ── Server-side bundling (for Rolldown/new Framer projects) ───────────────
  // Rolldown page chunk URLs (sites/*.mjs) can't be used with `npx unframer`
  // because the chunk exports the full page, not individual components.
  // We pre-bundle using esbuild on the server instead.
  await log("bundling", `${crawl.componentEntries.length} components via esbuild`, 45)
  const framerOutDir = path.join(jobDir, "framer")
  const bundleResult = await bundleFramerComponents({
    componentEntries: crawl.componentEntries,
    knownNames,
    outDir: framerOutDir,
    siteBase: crawl.siteBase,
  })
  console.log(`[${jobId}] Bundled: ${bundleResult.bundled.join(", ")} | Failed: ${bundleResult.failed.join(", ") || "none"}`)

  await log("processing", `${crawl.pages.length} pages`, 50)
  const processed = await processDOM(crawl, jobDir)
  await log("processing", "complete", 60)

  await log("building-config", undefined, 70)
  // Only include old-style /modules/ URLs in unframer.config.json
  const unframerConfig = buildUnframerConfig(
    manifest.projectId, mergedComponents, crawl.siteBase, crawl.pageChunkUrls
  )
  await fs.writeFile(path.join(jobDir, "unframer.config.json"), unframerConfig)

  await log("building-scaffold", undefined, 80)
  const hasPreBundled = bundleResult.bundled.length > 0
  const { setupCommand } = buildSetupInstructions(manifest.projectId, mergedComponents, hasPreBundled)
  const scaffold = buildAppScaffold(
    manifest, mergedComponents, crawl.componentEntries, processed,
    bundleResult.bundled  // tell scaffold which components are pre-bundled
  )
  await fs.writeFile(path.join(jobDir, "App.tsx"), scaffold)

  await log("packaging", undefined, 90)
  await packageZip(jobDir, crawl, processed, unframerConfig, scaffold, manifest, framerOutDir, bundleResult.bundled)
  await log("done", undefined, 100)
}

async function writeStatus(jobDir: string, data: object) {
  await fs.writeFile(path.join(jobDir, "status.json"), JSON.stringify(data, null, 2))
}

const PORT = Number(process.env.PORT ?? 4000)
app.listen(PORT, () => {
  console.log(`\n🚀 Export server → http://localhost:${PORT}`)
  console.log(`   Plugin proxies to this via Vite: /api/* → http://localhost:${PORT}\n`)
})
