# idk-subs v3.0 (Cloudflare Workers AI + Nikse SubtitleEdit Port)

A 100% free, zero-maintenance, 0ms cold-start Stremio addon for **AI-adapted Israeli Hebrew subtitles**, built natively for **Cloudflare Workers** + **Cloudflare Workers AI (`@cf/google/gemma-3-12b-it`)** and **Nikse's SubtitleEdit (`libse`)** algorithms.

---

## Why the Original `best-free-hebrew-ai-subs-v2` Was Broken
1. **Permanent `"מתרגם כתוביות... נסה שוב בעוד כמה שניות"` Loop:** The original addon returned a 1-cue placeholder SRT while trying to translate in the background, and its background AI key/quota was exhausted.
2. **Cache Poisoning (`max-age=1800`):** It attached `Cache-Control: public, max-age=1800` to that placeholder SRT, forcing Stremio and Cloudflare to cache the error message for 30 minutes.
3. **Render Free-Tier Spin-Downs:** Hosted on Render's free tier, which sleeps after 15 minutes of inactivity (causing 30–50s cold-start timeouts in Stremio and wiping its in-memory cache).

---

## How `idk-subs v3.0` Fixes Everything
1. **100% Uptime & Zero Maintenance (Cloudflare Workers):**
   - Never sleeps, 0ms cold starts worldwide.
   - Uses native **Cloudflare Workers AI** (`env.AI` with `@cf/google/gemma-3-12b-it`)—no external API keys to rotate or expire.
   - Built-in **3-Tier Caching**: Isolate Memory -> Cloudflare Global Edge Cache (`caches.default`, zero config required) -> Optional Cloudflare KV (`SUBS_KV`).
2. **Strict Exact-Sync Gate (`src/sources.js`):**
   - **Never wastes AI tokens on out-of-sync subtitles.**
   - Only translates when an English subtitle is verified to match your stream's **exact 64-bit `videoHash`** (which matches embedded/extracted tracks and exact video files) or **exact release group + rip format** (`filename`, e.g., `ATVP.WEB-DL-FLUX`).
   - If no synced English subtitle exists, it immediately returns `{ "subtitles": [] }` (just like Wizdom) and burns **0 tokens**.
3. **Nikse SubtitleEdit (`libse`) Pre- & Post-Processing (`src/subedit.js`):**
   - **Pre-Processing (ported from `RemoveTextForHI.cs` & `Utilities.cs`):**
     - Strips `[HI]`, `(SDH)`, `{tags}`, and nested tags like `(WOMAN (V.O.)):`.
     - Strips music cues (`♪`, `♫`) and ALL-CAPS sound effects (`THUNDER RUMBLES`) while keeping whitelisted uppercase words (`OK`, `CIA`, `TV`, `I`).
     - Strips speaker labels (`JOHN:`, `- [SARAH]:`, mid-line `Wait. JOHN: No!`) while automatically inserting dialogue dashes (`- `) when two speakers talk in the same cue.
     - Unwraps artificial 2-line single-speaker English breaks into a single logical sentence so Gemma 3 12B adapts the full thought naturally.
   - **Post-Processing (ported from `TextSplit.cs` & `Utilities.cs`):**
     - **Hebrew `AutoBreakLine`:** Keeps cues $\le 42$ chars on a single line. Breaks longer cues into 2 balanced lines at natural punctuation (`,`, `.`, `?`, `!`) or before Hebrew conjunctions (`אבל`, `כי`, `אם`, `כדי`, `ש...`, `ו...`), and **never** breaks after Hebrew prepositions/construct markers (`את`, `של`, `על`, `עם`, `אל`, `לא`, `אין`).
     - **Stremio RTL BiDi Punctuation Fix (`\u200F` / RLM):** Wraps Hebrew lines with Unicode Right-to-Left Marks so periods, question marks, exclamation marks, quotes, and leading dialogue dashes (`- `) render on the correct side across all Stremio devices (TV, Android, Desktop, Web).
4. **Seamless Single-URL Parallel Worker Pool (`src/translator.js` & `src/index.js`):**
   - Pre-warms translation the instant Stremio queries `/subtitles/...` (`ctx.waitUntil`).
   - Runs up to 10 concurrent micro-batches in parallel on Cloudflare's edge so a full episode finishes in ~5–10 seconds.
   - Holds the single `.srt` request open until the parallel pool finishes, returning the complete Hebrew `.srt` in one shot (no "Reload" second track needed).
   - If the AI provider ever errors or hits daily quota, returns HTTP `503` with `Cache-Control: no-store` (never caching a broken file).

---

## Zero-CLI Browser Deployment (No Local Node.js Needed!)

Because this project has **zero external npm runtime dependencies** (100% pure standard Web/Worker ES Modules), you can deploy it in 2 minutes either via **GitHub + Cloudflare Dashboard** or via **Wrangler CLI**:

### Option A: Deploy via Cloudflare Dashboard (100% in Browser)
1. Push this folder (`c:\Users\stavd\Downloads\idk-subs`) to a free private or public GitHub repository (or upload the files in the Cloudflare Workers dashboard).
2. Go to **Cloudflare Dashboard** -> **Compute (Workers & Pages)** -> **Create** -> **Import a repository** (or create a Worker).
3. Cloudflare will automatically read [`wrangler.toml`](file:///c:/Users/stavd/Downloads/idk-subs/wrangler.toml) and bind native Workers AI (`AI`).
4. Once deployed, install your addon in Stremio using:
   ```text
   https://idk-subs.<your-subdomain>.workers.dev/manifest.json
   ```

### Option B: Deploy via Terminal (Wrangler CLI)
If you install Node.js (`winget install OpenJS.NodeJS.LTS`), run:
```powershell
cd c:\Users\stavd\Downloads\idk-subs
npm install
npx wrangler deploy
```
