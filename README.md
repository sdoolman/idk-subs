# idk-subs v3 🍿🇮🇱

**An open-source, zero-maintenance Stremio addon for AI-adapted Hebrew subtitles that doesn't get stuck on `"מתרגם כתוביות... נסה שוב בעוד כמה שניות"`.**

---

## Why This Exists

If you watch Stremio in Israel, you probably already have **Wizdom** and **Ktuvit** installed. They're great when a human translator has already subbed your movie or episode—but for niche releases, older seasons, anime, or fresh drops, you're often out of luck.

When **`idk subs` (`best-free-hebrew-ai-subs-v2`)** showed up on `stremio-addons.net`, the concept was awesome: automatic AI-translated Hebrew subtitles right inside Stremio.

The problem? **It broke under its own weight:**
1. **TheRender Free-Tier Coma:** Hosted on a single free Render container that spins down after 15 minutes of inactivity, causing 40-second cold starts that time out Stremio's subtitle loader.
2. **The Shared API Key Bottleneck:** One person's AI quota shared with thousands of Stremio users inevitably hits rate limits.
3. **The 30-Minute Cache Trap:** Whenever it failed or was busy, it returned a 1-line `.srt` (`מתרגם כתוביות... נסה שוב בעוד כמה שניות`) with `Cache-Control: public, max-age=1800`—locking Stremio into caching that placeholder for half an hour.

So instead of relying on one shared server, **this repo lets any dev spin up their own personal, 100% free instance on Cloudflare Workers in 60 seconds**—powered by Cloudflare's built-in **Gemma 4** AI and **SubtitleEdit (`libse`)** algorithms.

---

## What Makes This Different (Adaptation, Not Just 1:1 Translation)

Throwing raw English `.srt` files at a translation API produces terrible Hebrew subtitles: `[SIGHING]` gets translated literally, `JOHN:` prefixes eat up screen space, lines break mid-phrase (`את\nהבית`), and Stremio flips punctuation to the wrong side of the sentence (`?מה קורה`).

`idk-subs v3` runs a **3-stage hybrid pipeline** inspired by Israeli fansub standards:

### 1. Deterministic Pre-Processing (Ported from Nikse's SubtitleEdit `libse`)
Before the AI sees a single word, [`src/subedit.js`](src/subedit.js) cleans the English track:
- **Strips HI / SDH Clutter:** Removes `[sighs]`, `(music playing)`, nested `(WOMAN (V.O.)):`, `♪` lyric lines, and scene watermarks.
- **Smart Speaker Colon Removal:** Strips `JOHN:` and mid-line `Wait here. SARAH: No way!` while automatically inserting dialogue dashes (`- `) when two speakers share a cue.
- **Unwraps Artificial English Line Breaks:** Merges 2-line single-speaker English wraps back into a single sentence so the AI translates the complete thought instead of two awkward half-clauses.

### 2. Contextual Scene Adaptation (`@cf/google/gemma-4-26b-a4b-it`)
- Uses **Cloudflare Workers AI** natively (`env.AI`)—**zero external API keys** to create, rotate, or pay for.
- Translates in **contextual scene batches** across a parallel worker pool so the model knows who is talking to whom (crucial for Hebrew male/female verb & pronoun agreement) and adapts idioms into natural spoken Hebrew.

### 3. Deterministic Hebrew Post-Processing
- **Hebrew-Aware `AutoBreakLine`:** Keeps cues $\le 42$ chars on one line. Splits longer cues into two balanced lines at natural punctuation or before conjunctions (`אבל`, `כי`, `אם`, `כדי`, `ש...`), while **never** splitting after Hebrew prepositions or construct-state markers (`את`, `של`, `על`, `עם`, `אל`, `לא`, `אין`).
- **Bulletproof Stremio RTL Punctuation (`\u200F`):** Wraps Hebrew lines with Unicode Right-to-Left Marks (RLM) so trailing `?`, `!`, `.`, and leading `- ` dialogue dashes always render on the right side across Desktop, Android TV, and Web.

---

## Known Limitations (Read Before Using!)

To keep this 100% free and genuinely good, this project makes a few deliberate trade-offs:

1. **Strict Exact-Sync Gate (No Out-of-Sync Token Burn):**
   Stremio addons cannot read embedded MKV subtitle tracks from your local player—they only receive `imdbId`, `videoHash`, `videoSize`, and `filename`. To avoid burning your daily AI quota translating a BluRay subtitle for a WEB-DL stream (which would be completely out of sync), [`src/sources.js`](src/sources.js) **only** translates when OpenSubtitles has an English `.srt` matching your stream's **exact `videoHash`** or **exact release group/format** (e.g., `ATVP.WEB-DL-FLUX`). If no synced English sub exists, the addon returns an empty list (`[]`) just like Wizdom and spends **0 tokens**.
2. **First-Watch Latency (~10–20 Seconds):**
   Adapting 600–1,200 lines through an LLM takes ~10–20 seconds on the very first play. The Worker starts pre-translating the instant you click a stream (while your video is still buffering), and caches the result in **Cloudflare KV + Edge Cache** so every replay or seek is instant (`0ms`).
3. **Cloudflare Free Tier Daily Quota (10,000 Neurons/day):**
   Cloudflare's free tier gives you 10,000 Workers AI Neurons per day at zero cost. That's plenty for your personal daily watching (several brand-new uncached episodes/movies per day, plus unlimited cached plays), which is why **self-hosting your own fork** is the way to go.

---

## Deploy Your Own Free Fork in 60 Seconds

This project has **zero runtime `npm` dependencies**—it runs entirely on native Cloudflare Workers Web APIs.

### Option 1: Fork & GitHub Actions (Recommended)
1. **Fork** this repository on GitHub.
2. In your fork, go to **Settings -> Secrets and variables -> Actions** and add:
   - `CLOUDFLARE_ACCOUNT_ID`: From your [Cloudflare Dashboard](https://dash.cloudflare.com/) sidebar.
   - `CLOUDFLARE_API_TOKEN`: Create a token at [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) using the **Edit Cloudflare Workers** template + **Workers AI (Edit)** + **Workers KV Storage (Edit)** permissions.
3. Trigger the **Test & Deploy Cloudflare Worker** workflow under the **Actions** tab (or push a commit to `main`).
4. Paste your live manifest URL into Stremio:
   ```text
   https://idk-subs.<your-subdomain>.workers.dev/manifest.json
   ```

### Option 2: Direct Local Deploy (With Node.js or Python)
```bash
# Using Wrangler (Node.js):
npm install
npx wrangler deploy

# Or using the built-in zero-dependency Python 3 script (reads ~/.cloudflare/config or env vars):
python scripts/deploy_cloudflare.py
```

### Configuration (`wrangler.toml`)
All upstream URLs and tuning knobs live in [`wrangler.toml`](wrangler.toml) `[vars]` so you can tweak them in the Cloudflare Dashboard without touching code:
- `AI_MODEL`: Defaults to `@cf/google/gemma-4-26b-a4b-it`
- `STRICT_SYNC_ONLY`: `"true"` (default) — set to `"false"` if you want it to translate the most popular English subtitle even when `videoHash`/`filename` doesn't match.
- `SINGLE_LINE_MAX_LENGTH`: `"42"` (standard Israeli broadcast max line length)

---

## Contributing

Contributions, Hebrew linguistic tweaks, and PRs are very welcome!

Some great areas to contribute:
- **Hebrew Line-Break & Adaptation Rules ([`src/subedit.js`](src/subedit.js)):** Expanding `HEBREW_NO_BREAK_AFTER` (construct states / סמיכות), `HEBREW_BREAK_BEFORE_WORDS`, or `HI_DESCRIPTION_WORDS`.
- **Additional Synced English Sources ([`src/sources.js`](src/sources.js)):** Adding more keyless English/anime subtitle providers while respecting the sync scorer.
- **Prompt Tuning ([`src/translator.js`](src/translator.js)):** Improving slang, gender inference, or batch throughput.

Before opening a PR, run the zero-dependency test suite (requires Node 18+):
```bash
node --test test/subedit.test.js
```

---

## Kudos & Credits 👏

- **Huge kudos to [`idk617866`](https://stremio-addons.net/users/idk617866)**, the creator of the original **idk subs (`best-free-hebrew-ai-subs-v2`)** addon! Having the idea to wire up on-the-fly AI Hebrew translations for Stremio—and generously hosting it for the community—inspired this entire project.
- **[Nikolaj Lynge Olsson (`niksedk`)](https://github.com/SubtitleEdit/subtitleedit)** and the **SubtitleEdit** contributors: Our HI/SDH tag stripper, speaker colon parser, and `AutoBreakLine` cost functions in [`src/subedit.js`](src/subedit.js) are directly ported from SubtitleEdit's battle-tested `libse` C# engine.
- **OpenSubtitles** & the **Stremio** team for the subtitle ecosystem and open addon protocol.

---

## License

Licensed under the [MIT License](LICENSE).
