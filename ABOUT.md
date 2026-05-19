# Framer Auto Export — Complete System

## What Was Built

A **full NoCodeExport-style pipeline** scaffolded with the **official Framer CLI** (`npm create framer-plugin@latest`), then extended with a production-grade server.

---

## Project Structure

```
framer-export-code/framer-export/
│
├── 🔌 PLUGIN (Framer canvas plugin — official CLI scaffold)
│   ├── src/App.tsx          ← Full plugin UI + scan + export flow
│   ├── src/App.css          ← Dark-mode premium styles
│   ├── framer.json          ← Plugin manifest (id, name, modes)
│   ├── vite.config.ts       ← Vite + vite-plugin-framer
│   └── package.json         ← framer-plugin v3 dependencies
│
└── 🖥 SERVER (Node.js export pipeline)
    ├── src/index.ts              ← Express API (POST /export, GET /status, GET /download)
    └── src/pipeline/
        ├── crawler.ts            ← Playwright crawl + network intercept
        ├── processor.ts          ← 12-step DOM processing
        ├── configBuilder.ts      ← unframer.config.json generator
        ├── scaffoldBuilder.ts    ← App.tsx scaffold generator
        └── packager.ts           ← ZIP packaging
```

---

## How to Run

### Terminal 1 — Export Server
```bash
cd framer-export-code/framer-export/server
npm run dev
# → http://localhost:4000
```

### Terminal 2 — Framer Plugin
```bash
cd framer-export-code/framer-export
npm run dev
# → http://localhost:5173
```

### In Framer
1. Press `Cmd+K` → search **"Open Development Plugin"**
2. Enter URL: `http://localhost:5173`
3. Plugin opens in the top-right panel

---

## How the Pipeline Works (NoCodeExport-style)

```
Plugin (Framer Canvas)                Server Pipeline
─────────────────────                 ─────────────────────────────────────────
① Scan canvas nodes                  ① Playwright launches headless Chromium
  • ComponentNode API                 ② Crawls ALL pages (follows nav links)
  • Extract CDN urls from             ③ Network intercept captures every:
    node internals                       framerusercontent.com/modules/*.js
  • Build layout order                   → maps ComponentName → CDN URL
  • Send manifest → server           ④ Auto-scrolls each page (lazy loads)
                                     ⑤ Merges plugin CDN map + server CDN map
② Poll status every 2.5s             ⑥ 12-step DOM processing:
  • Shows live progress bar              Strip Framer runtime scripts
  • Shows log messages                   Remove analytics/tracking
                                         Fix responsive variants
③ Download ZIP when done                 Extract inline styles → CSS
                                         Rewrite asset URLs → local
                                         Fix internal links
                                         Add polyfills
                                     ⑦ Build unframer.config.json
                                     ⑧ Build App.tsx scaffold
                                        (correct layout order from canvas)
                                     ⑨ Package ZIP:
                                        site/       ← deploy to Netlify
                                        react-app/  ← run npx unframer
```

---

## ZIP Output Structure

```
framer-export.zip
├── site/
│   ├── index.html          ← Cleaned, static HTML (no Framer runtime)
│   ├── about.html          ← All pages discovered
│   ├── assets/             ← All images + fonts downloaded
│   └── styles.css
│
├── react-app/
│   ├── src/
│   │   ├── App.tsx         ← Auto-generated, correct section order
│   │   ├── main.tsx
│   │   └── framer/         ← npx unframer populates this
│   ├── unframer.config.json ← All component CDN URL mappings
│   ├── package.json
│   └── README.md
│
└── manifest.json           ← Full component + layout data
```

---

## Key Differences vs Manual Approach

| Manual | This System |
|--------|-------------|
| Copy each component URL by hand | Network intercept captures 100% automatically |
| Guess layout order | Canvas layout order preserved from plugin scan |
| Build App.tsx from scratch | Auto-generated with all imports + correct section order |
| Run unframer config manually | unframer.config.json auto-written with all entries |
| Download assets manually | All images + fonts downloaded automatically |
| Strip Framer scripts manually | 12-step pipeline handles everything |
