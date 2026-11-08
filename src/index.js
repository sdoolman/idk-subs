/**
 * idk-subs v3.0 — Zero-Maintenance Cloudflare Worker Stremio Addon
 *
 * Key architectural guarantees:
 * 1. 100% Uptime & 0ms Cold Starts on Cloudflare Workers global edge.
 * 2. Strict Exact-Sync Gate (`sources.js`): Only translates if an English subtitle is verified
 *    to match the playing stream's `videoHash` or exact release group/format (`filename`).
 *    Otherwise returns `{ subtitles: [] }` immediately with 0 tokens burned.
 * 3. Pre-warm + Single-URL Hold-and-Release:
 *    - When Stremio calls `/subtitles/:type/:id/:extra.json`, we verify the synced English source
 *      and immediately start the parallel Gemma 3 12B translation pool via `ctx.waitUntil(...)`.
 *    - We return a SINGLE clean subtitle track (`/ai-sub/<fileId>.srt`).
 *    - When Stremio requests `/ai-sub/<fileId>.srt`, we await the in-flight translation promise
 *      so the user gets the complete, SubtitleEdit-formatted Hebrew `.srt` in one seamless load.
 * 4. Multi-Tier Caching (In-Memory Map -> Cloudflare Global Edge Cache API -> Optional KV):
 *    - Never caches errors or incomplete results (`no-store` on errors).
 *    - Caches completed Hebrew `.srt` files for 1 year (`max-age=31536000, immutable`).
 */

import {
  parseStremioRequest,
  findSyncedEnglishSubtitle,
  downloadEnglishSrt,
} from "./sources.js";
import { adaptSrtToHebrew } from "./translator.js";

const ADDON_MANIFEST = {
  id: "community.hebrew-ai-subs.v3",
  version: "3.0.0",
  name: "idk subs (Gemma 4 + SubtitleEdit)",
  description:
    "AI-adapted Israeli Hebrew subtitles powered by Cloudflare Workers AI (Gemma 4 26B-A4B) & Nikse SubtitleEdit (libse). Strict exact-sync matching only.",
  types: ["movie", "series"],
  catalogs: [],
  resources: [
    {
      name: "subtitles",
      types: ["movie", "series"],
      idPrefixes: ["tt", "kitsu"],
    },
  ],
  idPrefixes: ["tt", "kitsu"],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * In-memory isolate state for coalescing concurrent requests & sharing in-flight promises
 * between `/subtitles/...` pre-warm and `/ai-sub/:token.srt` download.
 */
const inFlightTranslations = new Map();
const memorySrtCache = new Map();

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 1. Root & Health Endpoints
      if (path === "/" || path === "") {
        return jsonResponse({
          addon: ADDON_MANIFEST.name,
          version: ADDON_MANIFEST.version,
          manifest: `${url.origin}/manifest.json`,
          aiManifest: `${url.origin}/ai/manifest.json`,
          health: `${url.origin}/health`,
        });
      }

      if (path === "/health") {
        return jsonResponse({
          ok: true,
          version: ADDON_MANIFEST.version,
          model: env?.AI_MODEL || "@cf/google/gemma-4-26b-a4b-it",
          inFlightJobs: inFlightTranslations.size,
          memoryCachedFiles: memorySrtCache.size,
          strictSyncOnly: (env?.STRICT_SYNC_ONLY ?? "true") !== "false",
        });
      }

      // 2. Manifest Endpoints (supports both `/manifest.json` and `/ai/manifest.json` like original v2)
      if (path === "/manifest.json" || path === "/ai/manifest.json") {
        return jsonResponse(ADDON_MANIFEST, 200, {
          "Cache-Control": "public, max-age=86400",
        });
      }

      // 3. Stremio Subtitles Resource Endpoint:
      // Matches `/subtitles/:type/:id.json`, `/subtitles/:type/:id/:extra.json`, and `/ai/subtitles/...`
      const subMatch = path.match(
        /^(?:\/ai)?\/subtitles\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.json$/i
      );
      if (subMatch) {
        const [, type, rawId, rawExtra = ""] = subMatch;
        return await handleSubtitlesQuery(url, type, rawId, rawExtra, env, ctx);
      }

      // 4. Adapted Hebrew SRT Delivery Endpoint (`/ai-sub/:token.srt`)
      const srtMatch = path.match(/^\/ai-sub\/([^/]+?)\.srt$/i);
      if (srtMatch) {
        const token = srtMatch[1];
        return await handleSrtDownload(url, token, env, ctx);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse(
        { error: err?.message || "Internal Server Error" },
        500,
        { "Cache-Control": "no-store" }
      );
    }
  },
};

/**
 * Handle Stremio `/subtitles/:type/:id/:extra.json`
 * - Checks strict sync gate via `findSyncedEnglishSubtitle`.
 * - If no synced English subtitle is found, returns `{ subtitles: [] }` (0 tokens spent).
 * - If found, immediately pre-warms translation in the background (`ctx.waitUntil`) and returns
 *   the single `.srt` URL.
 */
async function handleSubtitlesQuery(url, type, rawId, rawExtra, env, ctx) {
  const reqContext = parseStremioRequest(type, rawId, rawExtra);
  const strictSyncOnly = (env?.STRICT_SYNC_ONLY ?? "true") !== "false";

  const sourceInfo = await findSyncedEnglishSubtitle(reqContext, strictSyncOnly, env);

  // Strict Sync Gate: If no synced English subtitle exists for this release/hash,
  // return empty list (just like Wizdom when no subtitle is found) and spend 0 AI tokens!
  if (!sourceInfo) {
    return jsonResponse(
      { subtitles: [] },
      200,
      { "Cache-Control": "public, max-age=120" }
    );
  }

  const token = encodeSubtitleToken({
    fileId: sourceInfo.fileId,
    downloadUrl: sourceInfo.downloadUrl,
    fallbackGzUrl: sourceInfo.fallbackGzUrl,
    releaseName: sourceInfo.releaseName,
  });

  // Pre-warm the full translation immediately while the user's video player is still buffering!
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(
      getOrTranslateHebrewSrt(url.origin, sourceInfo, env, ctx, true).catch(() => {})
    );
  }

  const syncLabel = sourceInfo.isHashMatch ? "Exact Hash Sync" : "Release Sync";

  return jsonResponse(
    {
      subtitles: [
        {
          id: `heb-ai-${sourceInfo.fileId}`,
          url: `${url.origin}/ai-sub/${token}.srt`,
          lang: "heb",
          title: `AI Hebrew (${syncLabel} • ${sourceInfo.releaseName})`,
        },
      ],
    },
    200,
    { "Cache-Control": "public, max-age=600" }
  );
}

/**
 * Handle `/ai-sub/:token.srt`
 * Holds the request open while the parallel worker pool finishes (or returns immediately if already
 * completed during the pre-warm phase), then serves the complete `.srt` file.
 * If the AI provider fails or hits quota, returns HTTP 503 with `Cache-Control: no-store` (never poisoning cache).
 */
async function handleSrtDownload(url, token, env, ctx) {
  const sourceInfo = decodeSubtitleToken(token);
  if (!sourceInfo || !sourceInfo.fileId) {
    return new Response("Invalid subtitle token", {
      status: 400,
      headers: { ...CORS_HEADERS, "Cache-Control": "no-store" },
    });
  }

  try {
    const { srt, isComplete } = await getOrTranslateHebrewSrt(
      url.origin,
      sourceInfo,
      env,
      ctx,
      false
    );

    return new Response(srt, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/x-subrip; charset=utf-8",
        "Cache-Control": isComplete
          ? "public, max-age=31536000, immutable"
          : "no-store, no-cache, must-revalidate",
      },
    });
  } catch (err) {
    // User requirement #1: Return a clean provider error (never a cached fake placeholder SRT)
    return new Response(
      JSON.stringify({
        error: "AI subtitle adaptation failed",
        details: err?.message || "Unknown error",
      }),
      {
        status: 503,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  }
}

/**
 * Coalesces concurrent requests for the same `fileId` and checks all 3 cache tiers:
 * Tier 1: Isolate Memory (`memorySrtCache`)
 * Tier 2: Cloudflare KV (`env.SUBS_KV`, if bound)
 * Tier 3: Cloudflare Global Edge Cache API (`caches.default`)
 */
async function getOrTranslateHebrewSrt(origin, sourceInfo, env, ctx, isBackgroundFullPass = false) {
  const cacheKeyId = `srt:v3:${sourceInfo.fileId}`;

  // Tier 1: Isolate in-memory cache
  if (memorySrtCache.has(cacheKeyId)) {
    return { srt: memorySrtCache.get(cacheKeyId), isComplete: true };
  }

  // Tier 2: Cloudflare KV (if configured)
  if (env?.SUBS_KV) {
    try {
      const kvHit = await env.SUBS_KV.get(cacheKeyId);
      if (kvHit) {
        memorySrtCache.set(cacheKeyId, kvHit);
        return { srt: kvHit, isComplete: true };
      }
    } catch (_) {}
  }

  // Tier 3: Cloudflare Global Edge Cache API (`caches.default` — free, built-in, zero config)
  const edgeCacheUrl = `${origin}/__cache/${encodeURIComponent(cacheKeyId)}.srt`;
  const edgeCache = typeof caches !== "undefined" ? caches.default : null;
  if (edgeCache) {
    try {
      const cachedResp = await edgeCache.match(edgeCacheUrl);
      if (cachedResp && cachedResp.ok) {
        const text = await cachedResp.text();
        if (text) {
          memorySrtCache.set(cacheKeyId, text);
          return { srt: text, isComplete: true };
        }
      }
    } catch (_) {}
  }

  // Coalesce in-flight translation jobs
  if (inFlightTranslations.has(cacheKeyId)) {
    return await inFlightTranslations.get(cacheKeyId);
  }

  const jobPromise = (async () => {
    try {
      const rawEnglishSrt = await downloadEnglishSrt(sourceInfo, env);
      const result = await adaptSrtToHebrew(rawEnglishSrt, env, {
        isBackgroundFullPass,
        timeBudgetMs: 18000,
      });

      if (result.isComplete) {
        // Save to Tier 1 (Memory)
        if (memorySrtCache.size > 50) {
          const oldestKey = memorySrtCache.keys().next().value;
          memorySrtCache.delete(oldestKey);
        }
        memorySrtCache.set(cacheKeyId, result.srt);

        // Save to Tier 2 (KV) & Tier 3 (Edge Cache) asynchronously
        const persistPromise = Promise.allSettled([
          env?.SUBS_KV
            ? env.SUBS_KV.put(cacheKeyId, result.srt, {
                expirationTtl: 60 * 60 * 24 * 90, // 90 days
              })
            : Promise.resolve(),
          edgeCache
            ? edgeCache.put(
                edgeCacheUrl,
                new Response(result.srt, {
                  headers: {
                    "Content-Type": "application/x-subrip; charset=utf-8",
                    "Cache-Control": "public, max-age=31536000, immutable",
                  },
                })
              )
            : Promise.resolve(),
        ]);

        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(persistPromise);
        } else {
          await persistPromise;
        }
      } else if (ctx && typeof ctx.waitUntil === "function") {
        // If the foreground request returned within the 18s budget before all batches finished,
        // finish the remaining 100% of batches in `ctx.waitUntil` and save to Edge Cache!
        ctx.waitUntil(
          adaptSrtToHebrew(rawEnglishSrt, env, { isBackgroundFullPass: true })
            .then(async (fullResult) => {
              memorySrtCache.set(cacheKeyId, fullResult.srt);
              if (edgeCache) {
                await edgeCache.put(
                  edgeCacheUrl,
                  new Response(fullResult.srt, {
                    headers: {
                      "Content-Type": "application/x-subrip; charset=utf-8",
                      "Cache-Control": "public, max-age=31536000, immutable",
                    },
                  })
                );
              }
            })
            .catch(() => {})
        );
      }

      return result;
    } finally {
      inFlightTranslations.delete(cacheKeyId);
    }
  })();

  inFlightTranslations.set(cacheKeyId, jobPromise);
  return await jobPromise;
}

/**
 * URL-safe Base64 token encoding/decoding for stateless edge routing.
 */
export function encodeSubtitleToken(payload) {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeSubtitleToken(token) {
  try {
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "===".slice((base64.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    return null;
  }
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
