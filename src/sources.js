/**
 * Source English Subtitle Discovery & Strict Exact-Sync Gate
 *
 * Enforces the user's strict zero-token-waste policy:
 * - We ONLY proceed if we can verify the English subtitle is synced to the exact video stream
 *   playing in Stremio (either via exact OpenSubtitles 64-bit `videoHash` byte-match OR
 *   exact release group / rip format match against Stremio's `filename`).
 * - If Stremio does not provide `videoHash`/`filename` or no English subtitle matches the exact
 *   release sync, we return `null` immediately (which causes the addon to return `{ subtitles: [] }`,
 *   just like Wizdom when no subtitle exists, burning 0 AI tokens).
 */

const DEFAULT_USER_AGENT = "trailerrs";
const DEFAULT_OS_REST_BASE = "https://rest.opensubtitles.org";
const DEFAULT_OS_STREMIO_BASE = "https://opensubtitles-v3.strem.io";
const DEFAULT_OS_UTF8_DL_BASE =
  "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file";

/**
 * Common video rip / source format tokens used in scene & P2P releases.
 */
const FORMAT_TOKENS = [
  "bluray",
  "bdrip",
  "brrip",
  "remux",
  "web-dl",
  "webdl",
  "webrip",
  "webr",
  "hdtv",
  "hdrip",
  "dvdrip",
  "hddvd",
];

/**
 * Streaming service / network tags that have distinct intro timings (e.g., Netflix vs. Amazon vs. Apple TV+).
 */
const SERVICE_TOKENS = [
  "amzn",
  "nf",
  "atvp",
  "dsnp",
  "hmax",
  "max",
  "pcok",
  "pmtp",
  "hulu",
  "bbc",
  "itvx",
  "cr",
  "crunchyroll",
  "bglobal",
];

/**
 * Normalize a filename/release string into lowercase tokens and extract release group & format metadata.
 */
export function parseReleaseMetadata(filename) {
  if (!filename) return null;

  const withoutExt = filename
    .replace(/\.(mkv|mp4|avi|mov|webm|srt|sub|ass|vtt)$/i, "")
    .trim();

  const lower = withoutExt.toLowerCase();
  const tokens = lower.split(/[\s._\-[\]()]+/).filter(Boolean);
  const tokenSet = new Set(tokens);

  // Extract release group (typically after the last `-`, e.g., `-FLUX`, `-NTb`, `-RARBG`)
  let releaseGroup = null;
  const groupMatch = withoutExt.match(/-([A-Za-z0-9]+)(?:\[[^\]]*\])?$/);
  if (groupMatch) {
    const candidate = groupMatch[1].toLowerCase();
    // Avoid mistaking "DL" in "WEB-DL" or "264" in "H-264" for a release group
    if (!["dl", "rip", "264", "265", "hevc", "avc", "aac", "ddp5", "atmos"].includes(candidate)) {
      releaseGroup = candidate;
    }
  }

  // Canonicalize rip format class (web vs bluray vs hdtv vs dvd)
  let formatClass = null;
  if (tokenSet.has("bluray") || tokenSet.has("bdrip") || tokenSet.has("brrip") || tokenSet.has("remux")) {
    formatClass = "bluray";
  } else if (
    lower.includes("web-dl") ||
    tokenSet.has("webdl") ||
    tokenSet.has("webrip") ||
    tokenSet.has("web")
  ) {
    formatClass = "web";
  } else if (tokenSet.has("hdtv") || tokenSet.has("pdtv") || tokenSet.has("dsr")) {
    formatClass = "hdtv";
  } else if (tokenSet.has("dvdrip") || tokenSet.has("dvd")) {
    formatClass = "dvd";
  }

  // Detect streaming service origin (AMZN, NF, ATVP, DSNP, etc.)
  const service = SERVICE_TOKENS.find((s) => tokenSet.has(s)) || null;

  return {
    raw: withoutExt,
    lower,
    tokens,
    tokenSet,
    releaseGroup,
    formatClass,
    service,
  };
}

/**
 * Strict sync verification between the user's playing video (`videoHash`, `videoSize`, `filename`)
 * and a candidate English subtitle from OpenSubtitles.
 *
 * Returns a positive score (`>= 100`) ONLY if the subtitle is guaranteed to be in sync:
 * - Score 1000+: Matched by OpenSubtitles `moviehash` (exact 64-bit byte hash of the video file!)
 * - Score 500+: Exact normalized filename stem match
 * - Score 300+: Exact release group match (e.g., `-FLUX`, `-NTb`, `-SPARKS`) + compatible format class
 * - Score 200+: Exact streaming service (`AMZN`, `NF`, `ATVP`, `DSNP`) + `WEB` format match
 * - Score 0: Rejected (potential out-of-sync timing -> do NOT translate or spend tokens)
 */
export function scoreSubtitleSync(candidate, videoContext) {
  const { videoHash, filename } = videoContext;
  const reqMeta = parseReleaseMetadata(filename);

  const matchedByHex =
    (candidate.MatchedBy === "moviehash") ||
    (videoHash &&
      candidate.MovieHash &&
      candidate.MovieHash !== "0" &&
      candidate.MovieHash.toLowerCase() === videoHash.toLowerCase()) ||
    candidate.m === "h";

  let syncScore = 0;

  // 1. Exact videoHash byte match (gold standard — embedded/extracted or exact file timing)
  if (matchedByHex) {
    syncScore = 1000;
  } else if (reqMeta) {
    const subFile = candidate.SubFileName || candidate.subtitleFileName || "";
    const movieRel = candidate.MovieReleaseName || candidate.movieReleaseName || "";
    const subMeta = parseReleaseMetadata(movieRel || subFile);
    const subFileMeta = parseReleaseMetadata(subFile);

    const candGroup = (
      candidate.InfoReleaseGroup ||
      candidate.releaseGroup ||
      subMeta?.releaseGroup ||
      subFileMeta?.releaseGroup ||
      ""
    ).toLowerCase();

    const candFormat = subMeta?.formatClass || subFileMeta?.formatClass || null;
    const candService = subMeta?.service || subFileMeta?.service || null;

    // 2. Exact stem match
    if (
      (subMeta && subMeta.lower === reqMeta.lower) ||
      (subFileMeta && subFileMeta.lower.startsWith(reqMeta.lower))
    ) {
      syncScore = 500;
    }
    // 3. Exact release group match (and format class doesn't conflict, e.g., both WEB or both BluRay)
    else if (
      reqMeta.releaseGroup &&
      candGroup &&
      reqMeta.releaseGroup === candGroup &&
      (!reqMeta.formatClass || !candFormat || reqMeta.formatClass === candFormat)
    ) {
      syncScore = 350;
    }
    // 4. Release group token appears explicitly inside the subtitle's release/file name
    else if (
      reqMeta.releaseGroup &&
      reqMeta.releaseGroup.length >= 3 &&
      (subMeta?.tokenSet.has(reqMeta.releaseGroup) || subFileMeta?.tokenSet.has(reqMeta.releaseGroup)) &&
      (!reqMeta.formatClass || !candFormat || reqMeta.formatClass === candFormat)
    ) {
      syncScore = 300;
    }
    // 5. Same streaming service (e.g., AMZN.WEB-DL == AMZN.WEB-DL)
    else if (
      reqMeta.service &&
      candService &&
      reqMeta.service === candService &&
      reqMeta.formatClass === "web" &&
      candFormat === "web"
    ) {
      syncScore = 220;
    }
    // 6. Same rip format class (e.g., both BluRay/BDRip/Remux or both WEB-DL/WEBRip)
    // All standard BluRay rips of the same movie share the exact retail disc frame timing,
    // and standard WEB-DL/WEBRip releases share the digital master timing.
    else if (reqMeta.formatClass && candFormat && reqMeta.formatClass === candFormat) {
      syncScore = 150;
    }
  } else if (!videoHash && !filename) {
    // 7. When a Stremio client (like Stremio Web or an external player stream) does not pass
    // `videoHash` or `filename` at all, score by trusted/popular primary English release so
    // the addon still loads in the Hebrew providers list instead of disappearing!
    syncScore = 110;
  }

  // If no strict sync match was found, reject (`0`)
  if (syncScore === 0) {
    return 0;
  }

  // Quality modifiers within the verified-sync tier:
  // Strongly prefer non-HI (`SubHearingImpaired === "0"`) over HI so fewer tags need stripping,
  // though our `subedit.js` pipeline strips HI cleanly if an HI track is the only synced match.
  const isHi = candidate.SubHearingImpaired === "1" || candidate.SubHearingImpaired === 1;
  if (!isHi) {
    syncScore += 40;
  }

  // Prefer trusted uploaders & non-auto-translated English sources
  if (candidate.SubAutoTranslation === "1") {
    return 0; // Never chain-translate an auto-translated subtitle
  }
  if (candidate.SubForeignPartsOnly === "1") {
    return 0; // Never translate forced/foreign-parts-only tracks
  }
  if (candidate.SubFromTrusted === "1" || candidate.UserRank === "trusted") {
    syncScore += 15;
  }

  const downloads = parseInt(candidate.SubDownloadsCnt || "0", 10);
  if (downloads > 0) {
    syncScore += Math.min(20, Math.log10(downloads + 1) * 4);
  }

  return syncScore;
}

/**
 * Parse Stremio's `id` and `extra` parameters.
 * Examples:
 * - Movie: `id = "tt0133093"`
 * - Series: `id = "tt0903747:1:1"` (imdbId:season:episode)
 * - Anime: `id = "kitsu:12345:1"`
 * - Extra: `"videoHash=09a2c49766325920&videoSize=733999104&filename=The.Matrix.1999.1080p.BluRay.x264-AMIABLE.mkv"`
 */
export function parseStremioRequest(type, rawId, rawExtra = "") {
  const decodedId = decodeURIComponent(rawId || "").replace(/\.json$/i, "");
  const parts = decodedId.split(":");

  let imdbId = null;
  let kitsuId = null;
  let season = null;
  let episode = null;

  if (parts[0].startsWith("tt")) {
    imdbId = parts[0];
    if (parts.length >= 3) {
      season = parseInt(parts[1], 10);
      episode = parseInt(parts[2], 10);
    }
  } else if (parts[0] === "kitsu" && parts.length >= 2) {
    kitsuId = parts[1];
    episode = parts[2] ? parseInt(parts[2], 10) : 1;
  }

  const extraParams = new URLSearchParams(decodeURIComponent(rawExtra || "").replace(/\.json$/i, ""));
  const videoHash = extraParams.get("videoHash") || null;
  const videoSize = extraParams.get("videoSize") ? parseInt(extraParams.get("videoSize"), 10) : null;
  const filename = extraParams.get("filename") || null;

  return {
    type,
    imdbId,
    kitsuId,
    season,
    episode,
    videoHash,
    videoSize,
    filename,
  };
}

/**
 * Query OpenSubtitles REST API + Stremio OpenSubtitles v3 for synced English subtitles.
 * Returns `{ fileId, downloadUrl, releaseName, syncScore, matchReason }` or `null` if no synced English sub exists.
 */
export async function findSyncedEnglishSubtitle(reqContext, strictSyncOnly = true, env = {}) {
  const { imdbId, season, episode, videoHash, videoSize, filename } = reqContext;

  const osRestBase = (env?.OS_REST_BASE || DEFAULT_OS_REST_BASE).replace(/\/+$/, "");
  const osStremioBase = (env?.OS_STREMIO_BASE || DEFAULT_OS_STREMIO_BASE).replace(/\/+$/, "");
  const osUtf8DlBase = (env?.OS_UTF8_DL_BASE || DEFAULT_OS_UTF8_DL_BASE).replace(/\/+$/, "");
  const userAgent = env?.OS_USER_AGENT || DEFAULT_USER_AGENT;

  const candidates = [];

  // 1. Query OpenSubtitles REST API by exact `moviehash` + `moviebytesize` first (fastest, 100% exact sync)
  const searchTasks = [];

  if (videoHash) {
    const hashUrl =
      `${osRestBase}/search/` +
      (videoSize ? `moviebytesize-${videoSize}/` : "") +
      `moviehash-${videoHash.toLowerCase()}/sublanguageid-eng`;

    searchTasks.push(
      fetchJsonWithTimeout(hashUrl, { "X-User-Agent": userAgent }, 4500).then((list) => {
        if (Array.isArray(list)) candidates.push(...list);
      })
    );
  }

  // 2. Query OpenSubtitles REST API by IMDb ID (+ season/episode) to match by exact `filename` / `releaseGroup`
  if (imdbId) {
    const numericImdb = imdbId.replace(/^tt0*/, "");
    let imdbUrl = `${osRestBase}/search/`;
    if (episode != null) imdbUrl += `episode-${episode}/`;
    imdbUrl += `imdbid-${numericImdb}/`;
    if (season != null) imdbUrl += `season-${season}/`;
    imdbUrl += `sublanguageid-eng`;

    searchTasks.push(
      fetchJsonWithTimeout(imdbUrl, { "X-User-Agent": userAgent }, 4500).then((list) => {
        if (Array.isArray(list)) candidates.push(...list);
      })
    );
  }

  // 3. Also query Stremio's native OpenSubtitles v3 mirror in parallel as a zero-rate-limit backup
  if (imdbId) {
    const stremioId = season != null && episode != null ? `${imdbId}:${season}:${episode}` : imdbId;
    const extraPath = videoHash
      ? `/videoHash=${encodeURIComponent(videoHash)}${videoSize ? `&videoSize=${videoSize}` : ""}`
      : "";
    const osV3Url = `${osStremioBase}/subtitles/${reqContext.type}/${stremioId}${extraPath}.json`;

    searchTasks.push(
      fetchJsonWithTimeout(osV3Url, {}, 4000).then((data) => {
        if (data && Array.isArray(data.subtitles)) {
          for (const s of data.subtitles) {
            if (s.lang === "eng" && s.url) {
              // Extract fileId from subs5.strem.io URL if present
              const fileIdMatch = s.url.match(/\/file\/(\d+)/);
              candidates.push({
                IDSubtitleFile: fileIdMatch ? fileIdMatch[1] : s.id,
                SubFileName: s.subtitleFileName || "",
                MovieReleaseName: s.movieReleaseName || "",
                InfoReleaseGroup: s.releaseGroup || "",
                SubFormat: "srt",
                SubLanguageID: "eng",
                SubHearingImpaired: "0",
                MatchedBy: s.m === "h" ? "moviehash" : "imdbid",
                DirectUtf8Url: s.url,
              });
            }
          }
        }
      })
    );
  }

  await Promise.allSettled(searchTasks);

  if (candidates.length === 0) return null;

  // Deduplicate by IDSubtitleFile and score each candidate
  const seenFileIds = new Set();
  let bestCandidate = null;
  let bestScore = 0;

  for (const cand of candidates) {
    const fileId = String(cand.IDSubtitleFile || "");
    if (!fileId || seenFileIds.has(fileId)) continue;
    if (cand.SubFormat && cand.SubFormat.toLowerCase() !== "srt") continue;

    // Ensure season/episode matches if this is a series request
    if (season != null && cand.SeriesSeason && String(cand.SeriesSeason) !== "0") {
      if (parseInt(cand.SeriesSeason, 10) !== season) continue;
    }
    if (episode != null && cand.SeriesEpisode && String(cand.SeriesEpisode) !== "0") {
      if (parseInt(cand.SeriesEpisode, 10) !== episode) continue;
    }

    const score = scoreSubtitleSync(cand, { videoHash, videoSize, filename });
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = cand;
    }
    seenFileIds.add(fileId);
  }

  if (!bestCandidate || bestScore === 0) {
    return null;
  }

  const fileId = String(bestCandidate.IDSubtitleFile);
  // Stremio's UTF-8 transcoding proxy (`subs5.strem.io`) serves any OpenSubtitles `IDSubtitleFile`
  // directly as clean UTF-8 uncompressed `.srt` with no gzip or CP1252 encoding issues!
  const utf8DownloadUrl =
    bestCandidate.DirectUtf8Url || `${osUtf8DlBase}/${fileId}`;

  const isExactSync = bestScore >= 200;
  const isFormatSync = bestScore >= 150 && bestScore < 200;

  return {
    fileId,
    downloadUrl: utf8DownloadUrl,
    fallbackGzUrl: bestCandidate.SubDownloadLink || null,
    releaseName: bestCandidate.MovieReleaseName || bestCandidate.SubFileName || fileId,
    syncScore: bestScore,
    isHashMatch: bestScore >= 1000,
    syncType: bestScore >= 1000 ? "Exact Hash" : isExactSync ? "Exact Release" : isFormatSync ? "Format Sync" : "Best Match",
  };
}

/**
 * Download the raw English `.srt` text from the resolved source.
 */
export async function downloadEnglishSrt(sourceInfo, env = {}) {
  const userAgent = env?.OS_USER_AGENT || DEFAULT_USER_AGENT;
  // 1. Primary: Stremio's UTF-8 OpenSubtitles mirror (`subs5.strem.io`)
  try {
    const resp = await fetchWithTimeout(sourceInfo.downloadUrl, {}, 6000);
    if (resp.ok) {
      const text = await resp.text();
      if (text && text.includes("-->")) {
        return text;
      }
    }
  } catch (_) {
    // Fallback below
  }

  // 2. Fallback: OpenSubtitles `.gz` link decompressed via Web `DecompressionStream`
  if (sourceInfo.fallbackGzUrl) {
    const resp = await fetchWithTimeout(
      sourceInfo.fallbackGzUrl,
      { "X-User-Agent": userAgent },
      6000
    );
    if (resp.ok && resp.body) {
      const ds = new DecompressionStream("gzip");
      const decompressedStream = resp.body.pipeThrough(ds);
      const text = await new Response(decompressedStream).text();
      if (text && text.includes("-->")) {
        return text;
      }
    }
  }

  throw new Error(`Failed to download English subtitle file ${sourceInfo.fileId}`);
}

async function fetchWithTimeout(url, headers = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        ...headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url, headers = {}, timeoutMs = 5000) {
  try {
    const resp = await fetchWithTimeout(url, headers, timeoutMs);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  }
}
