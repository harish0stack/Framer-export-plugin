# Framer-export-plugin
a free export plugin using a backend server hosted on the local machine

the plugin spits out the zip file containing the code and just need to run directly on the local machine using "npm install" --> npm run dev  

## Note to change the id=root to main name in index.html of div container and as well as the main.tsx  for now

## my future change would be to get the better react code 
### The 4-Tier Architecture (What We Built):

```
TIER 1: Framer Bundles (Runtime - Untouchable)
├── _framerBundle.js
├── _framerBundle1.js
└── styles.css
↓ (Abstracted by)

TIER 2: Component Wrappers (Optional Customization)
├── components/Button.jsx
├── components/Card.jsx
└── components/index.js
↓ (Composed into)

TIER 3: Semantic Sections (Human-Level Organization)
├── sections/HeroSection.jsx
├── sections/PricingSection.jsx
└── sections/index.js
↓ (Orchestrated by)

TIER 4: Application Layer (User Customization)
├── main.jsx
├── App.jsx
└── types/framer.d.ts
```

**Why this works:**

- ✅ Bundles are hidden (developers don't see scary code)
- ✅ Sections are human-readable (clear page structure)
- ✅ Wrappers allow customization (override if needed)
- ✅ Types provide IDE support (TypeScript benefits)
- ✅ Re-exports safe (only update framer/ folder)

---

## 🎯 **Your Plugin Enhancement Roadmap**

### Phase 1: Immediate (Current Setup) ✅

- [x]  Semantic section structure
- [x]  Component wrappers
- [x]  Documentation

### Phase 2: Short-Term (3-4 Weeks) 🔥 **START HERE**

**Effort**: 40-80 hours

```
Week 1-2: Auto-detect page structure
         Auto-generate sections in export

Week 2-3: Auto-generate component wrappers

Week 3-4: Generate TypeScript type files (.d.ts)
         Generate documentation with examples
```

**After Phase 2**: Every export is automatically organized ✅

### Phase 3: Medium-Term (Future)

```
- Advanced JSX extraction (if Framer API allows)
- AI-based code cleanup
- Storybook integration
- Component library versioning
```

---

## 💡 **The "No Headaches" Promise - How to Achieve It**

### Current Challenges → Solutions:

| Challenge | Why It's Hard | Solution | Feasibility |
| --- | --- | --- | --- |
| Bundle mystery | Can't debundle | Keep + wrap it | ✅ DONE |
| No structure | JSX everywhere | Semantic sections | ✅ DONE |
| Hard to edit | Afraid to modify | Safe wrappers | ✅ DONE |
| Team confusion | Unclear flow | Documentation | ✅ DONE |
| Re-export fear | What if I break it? | Protected layers | ✅ DONE |
| Type safety | No IDE support | Generate .d.ts | ⭐ NEXT |

## SET UP

Step 1: Setup the Backend Server (The Extractor)
Open a terminal and navigate to the server folder:
bash
cd framer-export/server
Install dependencies (This automatically downloads Playwright, ESBuild, and the Chromium browsers for their specific OS):
bash
npm install
Start the server:
bash
npm run dev
(The server is now running on localhost:4000)
Step 2: Setup the Frontend (The UI for requesting exports)
(Assuming your UI is in the root directory)

Open a new terminal window and navigate to the root frontend folder:
bash
cd framer-export
Install frontend dependencies:
bash
npm install
Start the frontend interface:
bash
npm run dev
(The UI is now running on localhost:5173)
Step 3: What happens when they test an export?
The developer enters a Framer URL into the frontend UI.
The Node server uses Playwright to scrape it and ESBuild to bundle it.
It generates a react-app.zip containing the extracted code and its own package.json configured with SWC.
When the developer unzips that folder, they just run npm install and npm run dev inside it to see the final, working components.
