import { framer } from "framer-plugin"
import { useState, useEffect, useRef } from "react"
import "./App.css"

// ─── Types ────────────────────────────────────────────────────────────────────
interface ComponentEntry {
  name: string; id: string
  type: "component" | "instance" | "code"
  cdnUrl: string | null; props: string[]
}
interface LayoutSection {
  name: string; order: number; top: number; cdnUrl: string | null
}
interface ScanData {
  projectId: string; projectName: string
  entries: ComponentEntry[]; layout: LayoutSection[]
}
interface JobStatus {
  stage: string; detail?: string; error?: string
}
type Stage = "idle" | "scanning" | "exporting" | "polling" | "done" | "error"

// ─── Attempt to read CDN url from node internals ──────────────────────────────
function extractCdnUrl(node: unknown): string | null {
  const n = node as Record<string, unknown>
  const paths = [
    (n.__definition as any)?.url,
    (n.definition as any)?.url,
    (n._component as any)?.url,
    (n.componentDefinition as any)?.url,
    (n.__component as any)?.url,
  ]
  for (const p of paths) {
    if (typeof p === "string" && p.includes("framerusercontent.com")) return p
  }
  return null
}

// ─── Stage display data ───────────────────────────────────────────────────────
const STAGE_LABEL: Record<string, string> = {
  pending: "Queued…",
  crawling: "Crawling all pages with headless browser…",
  processing: "Processing DOM — 12-step pipeline…",
  "building-config": "Building unframer config…",
  "building-scaffold": "Generating React app scaffold…",
  packaging: "Packaging ZIP…",
  done: "Complete!",
  error: "Error",
}
const STAGE_PCT: Record<string, number> = {
  pending: 5, crawling: 25, processing: 55,
  "building-config": 72, "building-scaffold": 88, packaging: 96, done: 100,
}

// ─── Show UI ──────────────────────────────────────────────────────────────────
framer.showUI({ position: "top right", width: 400, height: 640 })

// ─── App ──────────────────────────────────────────────────────────────────────
export function App() {
  const [stage, setStage]         = useState<Stage>("idle")
  // Server calls go through Vite's proxy (/api → http://localhost:4000)
  // so HTTPS mixed-content is never an issue.
  const [serverPort, setServerPort] = useState("4000")
  const [siteUrl, setSiteUrl]     = useState("")
  const [scan, setScan]           = useState<ScanData | null>(null)
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null)
  const jobIdRef                  = useRef<string | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [logs, setLogs]           = useState<string[]>([])
  const pollRef  = useRef<ReturnType<typeof setInterval>>()
  const logBoxRef = useRef<HTMLDivElement>(null)

  const busy = stage === "scanning" || stage === "exporting" || stage === "polling"

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])
  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight
  }, [logs])

  const log = (msg: string) =>
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString("en", { hour12: false })} ${msg}`])

  // ── STEP 1: Canvas scan ─────────────────────────────────────────────────────
  async function scanCanvas() {
    setStage("scanning"); setError(null); setScan(null); setLogs([])
    log("Scanning Framer canvas…")
    try {
      const info = await framer.getProjectInfo()
      const projectId   = (info as any).id ?? (info as any).projectId ?? "unknown"
      const projectName = (info as any).name ?? "Framer Project"
      log(`Project: "${projectName}" (${projectId})`)

      // framer-plugin v3 uses "ComponentNode" for both master components and instances
      const compNodes  = await framer.getNodesWithType("ComponentNode")
      const instNodes: typeof compNodes = [] // instances are included in ComponentNode results
      log(`Found ${compNodes.length} components + ${instNodes.length} instances on canvas`)

      const entries: ComponentEntry[] = []
      const seen = new Set<string>()

      for (const node of compNodes) {
        const name = String((node as any).name ?? "Unnamed")
        if (seen.has(name)) continue; seen.add(name)
        entries.push({ name, id: String((node as any).id ?? name), type: "component",
          cdnUrl: extractCdnUrl(node), props: Object.keys((node as any).controls ?? {}) })
      }
      for (const node of instNodes) {
        const name = String((node as any).componentName ?? (node as any).name ?? "Unnamed")
        if (seen.has(name)) continue; seen.add(name)
        const cdnUrl = extractCdnUrl(node)
        entries.push({ name, id: String((node as any).id ?? name),
          type: cdnUrl ? "code" : "instance", cdnUrl,
          props: Object.keys((node as any).controls ?? {}) })
      }

      // Layout from canvas root children
      const layout: LayoutSection[] = []
      try {
        const root     = await (framer as any).getCanvasRoot?.()
        const children = (root as any)?.children ?? []
        ;(children as any[]).forEach((c: any, i: number) => {
          const name   = String(c?.name ?? `Section${i}`)
          const top    = Number(c?.y ?? c?.rect?.y ?? i * 100)
          const entry  = entries.find(e => e.name === name || (c as any).componentName === e.name)
          layout.push({ name, order: i, top, cdnUrl: entry?.cdnUrl ?? null })
        })
        layout.sort((a, b) => a.top - b.top)
      } catch (_) {}

      const resolved = entries.filter(e => e.cdnUrl).length
      log(`✓ Scan done — ${entries.length} unique components, ${resolved} CDN URLs from canvas`)
      log(resolved < entries.length
        ? `→ Server crawl will resolve the remaining ${entries.length - resolved}`
        : "→ All CDN URLs resolved from canvas!")

      setScan({ projectId, projectName, entries, layout })
      setStage("idle")
    } catch (err: any) {
      setError(err.message ?? String(err)); setStage("error")
    }
  }

  // ── STEP 2: Full export ─────────────────────────────────────────────────────
  async function startExport() {
    if (!scan || !siteUrl.trim()) return
    setStage("exporting"); setError(null)
    log("Connecting to export server (via Vite proxy)…")

    try {
      // Calls go to /api/* which Vite proxies to http://localhost:4000 server-side.
      // No HTTPS/mixed-content issues — the proxy is transparent.
      const health = await fetch("/api/health").catch(() => null)
      if (!health?.ok) throw new Error(
        `Export server not reachable.\n\n` +
        `Start it with:  cd server && npm run dev\n` +
        `(should show: http://localhost:${serverPort})`
      )
      log("✓ Server online")

      // Build manifest
      const components: Record<string, string> = {}
      scan.entries.forEach(e => { if (e.cdnUrl) components[e.name] = e.cdnUrl })

      const manifest = {
        projectId: scan.projectId, projectName: scan.projectName,
        publishedUrl: siteUrl.trim(), components,
        layout: scan.layout, rawEntries: scan.entries,
        generatedAt: new Date().toISOString(),
      }

      // POST to server via Vite proxy
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest, publishedUrl: siteUrl.trim() }),
      })
      if (!res.ok) throw new Error(await res.text())
      const { jobId: id } = await res.json()
      jobIdRef.current = id; setStage("polling")
      log(`✓ Job started — ID: ${id}`)
      log("Server is crawling your published site… (30–90s)")

      // Poll for status
      pollRef.current = setInterval(async () => {
        try {
          const st: JobStatus = await fetch(`/api/status/${id}`).then(r => r.json())
          setJobStatus(st)
          if (st.stage === "done") {
            clearInterval(pollRef.current!)
            log("✓ Export complete! Downloading ZIP…")
            setStage("done")
            // window.open is blocked in Framer's iframe — use blob download instead
            try {
              const zipRes = await fetch(`/api/download/${id}`)
              if (!zipRes.ok) throw new Error("Download failed")
              const blob = await zipRes.blob()
              const blobUrl = URL.createObjectURL(blob)
              const a = document.createElement("a")
              a.href = blobUrl
              a.download = "framer-export.zip"
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(blobUrl)
              log("✓ ZIP saved to Downloads folder")
            } catch (dlErr: any) {
              log(`⚠ Auto-download failed: ${dlErr.message}`)
              log(`  → Open this URL manually: ${location.origin}/api/download/${id}`)
            }
          } else if (st.stage === "error") {
            clearInterval(pollRef.current!); throw new Error(st.error ?? "Pipeline error")
          } else {
            log(`  › ${STAGE_LABEL[st.stage] ?? st.stage}${st.detail ? " — " + st.detail : ""}`)
          }
        } catch (err: any) {
          clearInterval(pollRef.current!); setError(err.message); setStage("error")
        }
      }, 2500)
    } catch (err: any) {
      setError(err.message ?? String(err)); setStage("exporting")
    }
  }

  function downloadManifestOnly() {
    if (!scan) return
    const components: Record<string, string> = {}
    scan.entries.forEach(e => { if (e.cdnUrl) components[e.name] = e.cdnUrl })
    const blob = new Blob([JSON.stringify({ projectId: scan.projectId,
      projectName: scan.projectName, publishedUrl: siteUrl || null,
      components, layout: scan.layout, rawEntries: scan.entries,
      generatedAt: new Date().toISOString() }, null, 2)], { type: "application/json" })
    const a = Object.assign(document.createElement("a"),
      { href: URL.createObjectURL(blob), download: `framer-manifest-${scan.projectId}.json` })
    a.click()
  }

  const cdnCount  = scan?.entries.filter(e => e.cdnUrl).length ?? 0
  const pct = stage === "done" ? 100 : STAGE_PCT[jobStatus?.stage ?? ""] ?? 0

  return (
    <div className="root">
      {/* ── Header ── */}
      <div className="header">
        <div className="header-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
              stroke="#6366f1" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div>
          <div className="header-title">Framer Auto Export</div>
          <div className="header-sub">Zero-config → React app pipeline</div>
        </div>
        {stage === "done" && <div className="header-badge">Done ✓</div>}
        {stage === "error" && <div className="header-badge err">Error</div>}
      </div>

      {/* ── Body ── */}
      <div className="body">

        {/* Server port */}
        <div className="field">
          <div className="field-label">Server Port</div>
          <input className="field-input" value={serverPort}
            onChange={e => setServerPort(e.target.value)}
            placeholder="4000" disabled={busy} style={{ width: 80 }} />
          <div className="field-hint">Vite proxies <code>/api/*</code> → <code>http://localhost:{serverPort}</code> — no HTTPS needed</div>
        </div>

        {/* Published URL */}
        <div className="field">
          <div className="field-label">Published Framer URL <span>*</span></div>
          <input className="field-input" value={siteUrl}
            onChange={e => setSiteUrl(e.target.value)}
            placeholder="https://yoursite.framer.website" disabled={busy} />
          <div className="field-hint">Needed for server crawl — resolves ALL component CDN URLs automatically</div>
        </div>

        <div className="sep" />

        {/* Step 1 */}
        <button className="btn btn-secondary" onClick={scanCanvas} disabled={busy}>
          {stage === "scanning" ? <><span className="spinner" /> Scanning canvas…</> : "① Scan Canvas Components"}
        </button>

        {/* Scan results */}
        {scan && (
          <>
            <div className="stats">
              <div className="stat">
                <div className="stat-num">{scan.entries.length}</div>
                <div className="stat-lbl">components</div>
              </div>
              <div className="stat-divider" />
              <div className="stat">
                <div className="stat-num" style={{ color: cdnCount > 0 ? "var(--green)" : "var(--t2)" }}>
                  {cdnCount}
                </div>
                <div className="stat-lbl">CDN urls</div>
              </div>
              <div className="stat-divider" />
              <div className="stat">
                <div className="stat-num">{scan.layout.length}</div>
                <div className="stat-lbl">sections</div>
              </div>
              <div className="stat-divider" />
              <div className="stat">
                <div className="stat-num" style={{ color: "var(--amber)" }}>
                  {scan.entries.length - cdnCount}
                </div>
                <div className="stat-lbl">server resolves</div>
              </div>
            </div>

            <div className="comp-list">
              {scan.entries.slice(0, 14).map(e => (
                <div key={e.id} className="comp-row">
                  <span className={`tag tag-${e.type}`}>{e.type}</span>
                  <span className="comp-name">{e.name}</span>
                  {e.cdnUrl
                    ? <span className="comp-url-ok">✓ CDN</span>
                    : <span className="comp-url-no">→ server</span>}
                </div>
              ))}
              {scan.entries.length > 14 && (
                <div className="comp-more">+{scan.entries.length - 14} more (all will be resolved)</div>
              )}
            </div>

            <button className="btn btn-ghost" onClick={downloadManifestOnly}>
              ↓ Download manifest.json only
            </button>

            <div className="sep" />

            {/* Step 2 */}
            <button
              className="btn btn-primary"
              onClick={startExport}
              disabled={busy || !siteUrl.trim()}
              title={!siteUrl.trim() ? "Enter your published Framer URL above" : ""}
            >
              {stage === "polling"
                ? <><span className="spinner" style={{ borderTopColor: "#fff" }} /> Exporting…</>
                : stage === "done"
                ? "② Download Again"
                : "② Full Auto Export →"}
            </button>
          </>
        )}

        {/* Progress */}
        {(stage === "polling" || stage === "done") && (
          <div className="progress-wrap">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-label">
              {jobStatus ? STAGE_LABEL[jobStatus.stage] ?? jobStatus.stage : "Starting…"}
            </div>
          </div>
        )}

        {/* Done */}
        {stage === "done" && (
          <div className="success-box">
            <div className="success-title">✓ Export Complete!</div>
            <div className="success-sub">
              ZIP downloaded — contains your cleaned site + React app scaffold with
              unframer.config.json. Run <code>npx unframer</code> inside react-app/ to
              pull all Framer components.
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="error-box">
            <span>⚠</span><span style={{ whiteSpace: "pre-wrap" }}>{error}</span>
          </div>
        )}

        {/* Log */}
        {logs.length > 0 && (
          <div className="log" ref={logBoxRef}>
            {logs.map((l, i) => <div key={i} className="log-line">{l}</div>)}
          </div>
        )}

      </div>
    </div>
  )
}
