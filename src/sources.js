/**
 * Source English Subtitle Discovery & Distinct Release Family Selection
 *
 * Architectural Policy:
 * 1. Listing subtitle options in `/subtitles/:type/:id/:extra.json` costs 0 AI tokens because
 *    we NEVER pre-warm or translate in the background when a user merely opens a video stream!
 *    AI translation ONLY runs when the user explicitly selects one of our tracks (`/ai-sub/:token.srt`).
 * 2. Exact Sync Priority + Distinct Release Families (Up to 3 Options):
 *    - If an English subtitle matches the playing stream's exact `videoHash` or exact release/group
 *      (`YIFY` == `YTS`, `-MeGusta` in `SubAuthorComment`, `-FLUX`, etc.), it is placed #1 (`★ Exact Sync`).
 *    - Up to 2 additional *genuinely distinct* timing/release families (e.g., a `BluRay` master vs.
 *      a `WEB-DL` master vs. a different OpenSubtitles timing group `SubTSGroup`) are also returned
 *      with clear release labels so the user is never left without an option when torrent filenames
 *      are non-standard (and can pick or manually offset the closest master in Stremio).
 */

const DEFAULT_USER_AGENT = "trailerrs";
const DEFAULT_OS_REST_BASE = "https://rest.opensubtitles.org";
const DEFAULT_OS_STREMIO_BASE = "https://opensubtitles-v3.strem.io";
const DEFAULT_OS_UTF8_DL_BASE =
  "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file";

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
 * Equivalent release group aliases (e.g., YIFY rebranded to YTS / YTS.MX / YTS.LT / YTS.AM).
 */
const RELEASE_GROUP_ALIASES = {
  yify: "yify",
  yts: "yify",
  "yts.mx": "yify",
  "yts.lt": "yify",
  "yts.am": "yify",
  "yts.ag": "yify",
};

function canonicalizeGroup(group) {
  if (!group) return null;
  const lower = group.toLowerCase().trim();
  return RELEASE_GROUP_ALIASES[lower] || lower;
}

/**
 * Normalize a filename/release string into lowercase tokens and extract release group & format metadata.
 */
export function parseReleaseMetadata(filename) {
  if (!filename) return null;

  // Strip known tracker watermarks (like [EZTVx.to], [TGx], [rartv], [ettv], [YTS.MX])
  // WITHOUT wiping out QxR/Tigole style release brackets like `[1080p BluRay x265 Tigole]`!
  const withoutExt = filename
    .replace(/\.(mkv|mp4|avi|mov|webm|srt|sub|ass|vtt)$/i, "")
    .replace(
      /\[(?:eztv[^\]]*|tgx|rartv|ettv|torrentgalaxy[^\]]*|yts\.[a-z]+|www\.[^\]]+)\]/gi,
      (match) => (/yts/i.test(match) ? "-YTS" : "")
    )
    .trim();

  const lower = withoutExt.toLowerCase();
  const tokens = lower.split(/[\s._\-[\]()]+/).filter(Boolean);
  const tokenSet = new Set(tokens);

  const NON_GROUP_TOKENS = new Set([
    "dl", "rip", "web", "webdl", "webrip", "bluray", "bdrip", "brrip", "remux", "hdtv", "dvdrip", "dvd",
    "264", "265", "x264", "x265", "h264", "h265", "hevc", "avc", "xvid", "divx", "av1",
    "aac", "ac3", "ddp5", "dd5", "dts", "atmos", "truehd", "flac", "mp3", "opus",
    "1080p", "720p", "2160p", "480p", "4k", "uhd", "hdr", "hdr10", "dv", "10bit", "8bit",
    "proper", "repack", "extended", "unrated", "directors", "cut", "remastered", "multi", "dual",
    "eng", "en", "heb", "he", "hi", "sdh", "sub", "subs", "srt", "1", "5", "7", "2", "0",
  ]);

  let releaseGroup = null;
  const cleanedForGroup = withoutExt.replace(/[)\]]+$/, "").trim();
  const groupMatch = cleanedForGroup.match(/-\s*([A-Za-z0-9]+)$/);
  if (groupMatch) {
    const candidate = groupMatch[1].toLowerCase();
    if (!NON_GROUP_TOKENS.has(candidate)) {
      releaseGroup = canonicalizeGroup(candidate);
    }
  } else if (tokens.length >= 4) {
    const hasTechToken = tokens.some((t) =>
      [
        "1080p", "720p", "2160p", "480p", "x264", "x265", "h264", "h265",
        "hevc", "xvid", "bluray", "brrip", "bdrip", "webrip", "webdl", "hdtv", "dvdrip",
      ].includes(t)
    );
    const lastToken = tokens[tokens.length - 1];
    if (
      hasTechToken &&
      lastToken.length >= 2 &&
      !/^\d+$/.test(lastToken) &&
      !NON_GROUP_TOKENS.has(lastToken)
    ) {
      releaseGroup = canonicalizeGroup(lastToken);
    }
  }

  if (!releaseGroup && (tokenSet.has("yify") || tokenSet.has("yts"))) {
    releaseGroup = "yify";
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
 * Returns a positive score (`>= 200`) ONLY if the subtitle is verified to match the playing stream:
 * - Score 1000+: Matched by OpenSubtitles `moviehash` (exact 64-bit byte hash of the video file!)
 * - Score 500+: Exact normalized filename stem match (or explicitly listed in `SubAuthorComment`)
 * - Score 350+: Exact release group match (e.g., `-FLUX`, `-NTb`, `-MeGusta`, `YIFY`/`YTS`)
 * - Score 220+: Exact streaming service (`AMZN`, `NF`, `ATVP`, `DSNP`) + `WEB` format match
 * - Score 0: Not an exact sync match for the current filename/hash.
 */
export function scoreSubtitleSync(candidate, videoContext) {
  if (candidate.SubAutoTranslation === "1" || candidate.SubForeignPartsOnly === "1") {
    return 0;
  }

  const { videoHash, filename } = videoContext;
  const reqMeta = parseReleaseMetadata(filename);

  const matchedByHex =
    candidate.MatchedBy === "moviehash" ||
    (videoHash &&
      candidate.MovieHash &&
      candidate.MovieHash !== "0" &&
      candidate.MovieHash.toLowerCase() === videoHash.toLowerCase()) ||
    candidate.m === "h";

  let syncScore = 0;

  if (matchedByHex) {
    syncScore = 1000;
  } else if (reqMeta) {
    const subFile = candidate.SubFileName || candidate.subtitleFileName || "";
    const movieRel = candidate.MovieReleaseName || candidate.movieReleaseName || "";
    const authorComment = (candidate.SubAuthorComment || "").toLowerCase();
    const subMeta = parseReleaseMetadata(movieRel || subFile);
    const subFileMeta = parseReleaseMetadata(subFile);

    const rawCandGroup = (
      candidate.InfoReleaseGroup ||
      candidate.releaseGroup ||
      subMeta?.releaseGroup ||
      subFileMeta?.releaseGroup ||
      ""
    )
      .replace(/\[[^\]]*\]/g, "")
      .replace(/-(?:sdh|hi)$/i, "")
      .toLowerCase();
    const candGroup = canonicalizeGroup(rawCandGroup);

    const candFormat = subMeta?.formatClass || subFileMeta?.formatClass || null;
    const candService = subMeta?.service || subFileMeta?.service || null;

    const commentHasExactFilename =
      reqMeta.lower.length >= 8 && authorComment.includes(reqMeta.lower);
    const commentHasReleaseGroup =
      reqMeta.releaseGroup &&
      reqMeta.releaseGroup.length >= 3 &&
      new RegExp(`[-.\\s]${reqMeta.releaseGroup}\\b`, "i").test(authorComment);

    if (
      (subMeta && subMeta.lower === reqMeta.lower) ||
      (subFileMeta && subFileMeta.lower.startsWith(reqMeta.lower)) ||
      commentHasExactFilename
    ) {
      syncScore = 500;
    } else if (
      reqMeta.releaseGroup &&
      (commentHasReleaseGroup ||
        (((candGroup && reqMeta.releaseGroup === candGroup) ||
          subMeta?.tokenSet.has(reqMeta.releaseGroup) ||
          subFileMeta?.tokenSet.has(reqMeta.releaseGroup)) &&
          (!reqMeta.formatClass || !candFormat || reqMeta.formatClass === candFormat)))
    ) {
      syncScore = 350;
    } else if (
      reqMeta.service &&
      candService &&
      reqMeta.service === candService &&
      reqMeta.formatClass === "web" &&
      candFormat === "web"
    ) {
      syncScore = 220;
    }
  }

  if (syncScore === 0) {
    return 0;
  }

  return syncScore + computeQualityBonus(candidate);
}

function computeQualityBonus(candidate) {
  let bonus = 0;
  const isHi = candidate.SubHearingImpaired === "1" || candidate.SubHearingImpaired === 1;
  if (!isHi) bonus += 40;
  if (candidate.SubFromTrusted === "1" || candidate.UserRank === "trusted") bonus += 15;
  const downloads = parseInt(candidate.SubDownloadsCnt || "0", 10);
  if (downloads > 0) {
    bonus += Math.min(20, Math.log10(downloads + 1) * 4);
  }
  return bonus;
}

/**
 * Compute a release-family signature for deduplicating OpenSubtitles candidates into genuinely
 * distinct timing editions (e.g., `web:amzn`, `bluray:yify`, `dvd`, or distinct `SubTSGroup`).
 */
function getReleaseFamilyDescriptor(cand) {
  const subFile = cand.SubFileName || cand.subtitleFileName || "";
  const movieRel = cand.MovieReleaseName || cand.movieReleaseName || "";
  const meta = parseReleaseMetadata(movieRel || subFile) || parseReleaseMetadata(subFile);

  const formatClass =
    meta?.formatClass ||
    (cand.releaseFormat ? cand.releaseFormat.toLowerCase().replace("web-dl", "web") : null) ||
    "standard";
  const service = meta?.service ? meta.service.toUpperCase() : null;
  const group =
    (cand.InfoReleaseGroup || cand.releaseGroup || meta?.releaseGroup || "")
      .replace(/-(?:sdh|hi)$/i, "")
      .trim() || null;

  const formatLabel =
    formatClass === "bluray"
      ? "BluRay"
      : formatClass === "web"
        ? service
          ? `${service} WEB-DL`
          : "WEB-DL"
        : formatClass === "dvd"
          ? "DVDRip"
          : formatClass === "hdtv"
            ? "HDTV"
            : "Standard";

  // Family key ensures we pick genuinely different timing masters (never 2 BluRay rips from the same timing group)
  const tsGroup = cand.SubTSGroup ? `ts${cand.SubTSGroup}` : null;
  const familyKey = `${formatClass}:${service || ""}:${tsGroup || (group ? group.toLowerCase() : "generic")}`;
  // Coarser bucket (`bluray`, `web:AMZN`, `web:`, `dvd`, `hdtv`) so we prefer different format classes first!
  const formatBucket = `${formatClass}:${service || ""}`;

  const cleanReleaseName = (movieRel || subFile || String(cand.IDSubtitleFile))
    .replace(/\.(srt|sub)$/i, "")
    .trim();

  return {
    familyKey,
    formatBucket,
    formatClass,
    formatLabel,
    group,
    cleanReleaseName,
  };
}

/**
 * Parse Stremio's `id` and `extra` parameters.
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
 * Query OpenSubtitles REST API + Stremio OpenSubtitles v3 and return up to `maxOptions` (default 3)
 * genuinely distinct English subtitle release options:
 * - Option 1 (if matched): The verified Exact Hash / Exact Release match (`★ Synced • ...`).
 * - Up to 2 distinct alternative release masters (different format class / timing group, e.g. BluRay vs WEB-DL vs DVD)
 *   so the user can always pick an alternative or manually sync if the torrent filename was unlabelled.
 */
export async function findEnglishSubtitleOptions(reqContext, env = {}, maxOptions = 3) {
  const { imdbId, season, episode, videoHash, videoSize, filename } = reqContext;

  const osRestBase = (env?.OS_REST_BASE || DEFAULT_OS_REST_BASE).replace(/\/+$/, "");
  const osStremioBase = (env?.OS_STREMIO_BASE || DEFAULT_OS_STREMIO_BASE).replace(/\/+$/, "");
  const osUtf8DlBase = (env?.OS_UTF8_DL_BASE || DEFAULT_OS_UTF8_DL_BASE).replace(/\/+$/, "");
  const userAgent = env?.OS_USER_AGENT || DEFAULT_USER_AGENT;

  const candidates = [];
  const debugSources = { restCount: 0, v3Count: 0, restStatus: null, v3Status: null };
  const searchTasks = [];

  // 1. Query OpenSubtitles REST API by exact `moviehash` + `moviebytesize`
  if (videoHash) {
    const hashUrl =
      `${osRestBase}/search/` +
      (videoSize ? `moviebytesize-${videoSize}/` : "") +
      `moviehash-${videoHash.toLowerCase()}/sublanguageid-eng`;

    searchTasks.push(
      fetchJsonWithTimeout(hashUrl, { "X-User-Agent": userAgent }, 4500).then((res) => {
        if (Array.isArray(res?.data)) {
          candidates.push(...res.data);
          debugSources.restCount += res.data.length;
        }
        debugSources.restStatus = res?.status;
      })
    );
  }

  // 2. Query OpenSubtitles REST API by IMDb ID (+ season/episode)
  if (imdbId) {
    const numericImdb = imdbId.replace(/^tt0*/, "");
    let imdbUrl = `${osRestBase}/search/`;
    if (episode != null) imdbUrl += `episode-${episode}/`;
    imdbUrl += `imdbid-${numericImdb}/`;
    if (season != null) imdbUrl += `season-${season}/`;
    imdbUrl += `sublanguageid-eng`;

    searchTasks.push(
      fetchJsonWithTimeout(imdbUrl, { "X-User-Agent": userAgent }, 4500).then((res) => {
        if (Array.isArray(res?.data)) {
          candidates.push(...res.data);
          debugSources.restCount += res.data.length;
        }
        debugSources.restStatus = res?.status;
      })
    );
  }

  // 3. Query Stremio's native OpenSubtitles v3 mirror in parallel
  if (imdbId) {
    const stremioId = season != null && episode != null ? `${imdbId}:${season}:${episode}` : imdbId;
    const extraPath = videoHash
      ? `/videoHash=${encodeURIComponent(videoHash)}${videoSize ? `&videoSize=${videoSize}` : ""}`
      : "";
    const osV3Url = `${osStremioBase}/subtitles/${reqContext.type}/${stremioId}${extraPath}.json`;

    searchTasks.push(
      fetchJsonWithTimeout(osV3Url, {}, 4000).then((res) => {
        debugSources.v3Status = res?.status;
        const data = res?.data;
        if (data && Array.isArray(data.subtitles)) {
          for (const s of data.subtitles) {
            if (s.lang === "eng" && s.url) {
              const fileIdMatch = s.url.match(/\/file\/(\d+)/);
              candidates.push({
                IDSubtitleFile: fileIdMatch ? fileIdMatch[1] : s.id,
                SubFileName: s.subtitleFileName || "",
                MovieReleaseName: s.movieReleaseName || "",
                InfoReleaseGroup: s.releaseGroup || "",
                releaseFormat: s.releaseFormat || "",
                SubTSGroup: s.g || null,
                SubFormat: "srt",
                SubLanguageID: "eng",
                SubHearingImpaired:
                  s.subtitleFileName && /[-.](?:HI|SDH)\b/i.test(s.subtitleFileName) ? "1" : "0",
                MatchedBy: s.m === "h" ? "moviehash" : "imdbid",
                DirectUtf8Url: s.url,
              });
              debugSources.v3Count++;
            }
          }
        }
      })
    );
  }

  await Promise.allSettled(searchTasks);
  reqContext.debugSources = debugSources;

  if (candidates.length === 0) return [];

  // Merge candidates by IDSubtitleFile so rich metadata from OpenSubtitles REST (`SubAuthorComment`,
  // `SubHearingImpaired`, `SubDownloadsCnt`) is preserved alongside `DirectUtf8Url` and `SubTSGroup`.
  const byFileId = new Map();
  for (const cand of candidates) {
    const fileId = String(cand.IDSubtitleFile || "");
    if (!fileId) continue;
    const existing = byFileId.get(fileId);
    if (!existing) {
      byFileId.set(fileId, { ...cand });
    } else {
      byFileId.set(fileId, {
        ...cand,
        ...existing,
        SubAuthorComment: existing.SubAuthorComment || cand.SubAuthorComment || "",
        DirectUtf8Url: existing.DirectUtf8Url || cand.DirectUtf8Url || null,
        SubTSGroup: existing.SubTSGroup || cand.SubTSGroup || null,
        releaseFormat: existing.releaseFormat || cand.releaseFormat || "",
      });
    }
  }

  const reqMeta = parseReleaseMetadata(filename);
  const scoredCandidates = [];

  for (const [, cand] of byFileId.entries()) {
    if (cand.SubFormat && cand.SubFormat.toLowerCase() !== "srt") continue;
    if (cand.SubAutoTranslation === "1" || cand.SubForeignPartsOnly === "1") continue;

    if (season != null && cand.SeriesSeason && String(cand.SeriesSeason) !== "0") {
      if (parseInt(cand.SeriesSeason, 10) !== season) continue;
    }
    if (episode != null && cand.SeriesEpisode && String(cand.SeriesEpisode) !== "0") {
      if (parseInt(cand.SeriesEpisode, 10) !== episode) continue;
    }

    const exactSyncScore = scoreSubtitleSync(cand, { videoHash, videoSize, filename });
    const desc = getReleaseFamilyDescriptor(cand);

    // Base quality score for ranking the best representative within each distinct release family
    let familyRankScore = computeQualityBonus(cand);
    // Prefer candidates that actually specify a known rip format / release group
    if (desc.formatClass !== "standard") familyRankScore += 25;
    if (desc.group) familyRankScore += 15;
    // Slight boost if formatClass matches the user's video formatClass
    if (reqMeta?.formatClass && desc.formatClass === reqMeta.formatClass) {
      familyRankScore += 30;
    }

    scoredCandidates.push({
      cand,
      exactSyncScore,
      familyRankScore,
      desc,
    });
  }

  if (scoredCandidates.length === 0) return [];

  // Sort primarily by exactSyncScore descending, then by familyRankScore descending
  scoredCandidates.sort((a, b) => {
    if (b.exactSyncScore !== a.exactSyncScore) return b.exactSyncScore - a.exactSyncScore;
    return b.familyRankScore - a.familyRankScore;
  });

  const selected = [];
  const usedFamilyKeys = new Set();
  const usedFormatBuckets = new Set();
  const usedReleaseNames = new Set();

  // Pass 1: If we have an Exact Sync match (`exactSyncScore >= 200`), always include the #1 exact match first!
  if (scoredCandidates[0].exactSyncScore >= 200) {
    const top = scoredCandidates[0];
    selected.push(buildOptionOutput(top, osUtf8DlBase, true));
    usedFamilyKeys.add(top.desc.familyKey);
    usedFormatBuckets.add(top.desc.formatBucket);
    usedReleaseNames.add(top.desc.cleanReleaseName.toLowerCase());
  }

  // Pass 2: Pick up to `maxOptions` genuinely distinct release formats (`formatBucket` differs: e.g. BluRay vs WEB-DL vs DVDRip)
  for (const item of scoredCandidates) {
    if (selected.length >= maxOptions) break;
    const relKey = item.desc.cleanReleaseName.toLowerCase();
    if (usedFormatBuckets.has(item.desc.formatBucket) || usedReleaseNames.has(relKey)) continue;

    selected.push(buildOptionOutput(item, osUtf8DlBase, item.exactSyncScore >= 200));
    usedFamilyKeys.add(item.desc.familyKey);
    usedFormatBuckets.add(item.desc.formatBucket);
    usedReleaseNames.add(relKey);
  }

  // Pass 3: If we still have fewer than `maxOptions` and there are other distinct timing groups (`SubTSGroup` / release group), add up to `maxOptions`
  for (const item of scoredCandidates) {
    if (selected.length >= maxOptions) break;
    const relKey = item.desc.cleanReleaseName.toLowerCase();
    if (usedFamilyKeys.has(item.desc.familyKey) || usedReleaseNames.has(relKey)) continue;

    selected.push(buildOptionOutput(item, osUtf8DlBase, item.exactSyncScore >= 200));
    usedFamilyKeys.add(item.desc.familyKey);
    usedReleaseNames.add(relKey);
  }

  return selected;
}

/**
 * Backwards-compatible helper returning the single top subtitle option (or `null`).
 */
export async function findSyncedEnglishSubtitle(reqContext, strictSyncOnly = true, env = {}) {
  const options = await findEnglishSubtitleOptions(reqContext, env, 3);
  if (options.length === 0) return null;
  if (strictSyncOnly && !options[0].isExactMatch) return null;
  return options[0];
}

function buildOptionOutput(item, osUtf8DlBase, isExactMatch) {
  const { cand, exactSyncScore, familyRankScore, desc } = item;
  const fileId = String(cand.IDSubtitleFile);
  const utf8DownloadUrl = cand.DirectUtf8Url || `${osUtf8DlBase}/${fileId}`;
  const isHashMatch = exactSyncScore >= 1000;

  let syncType;
  if (isHashMatch) {
    syncType = `★ Exact Hash • ${desc.formatLabel}`;
  } else if (isExactMatch) {
    syncType = `★ Synced • ${desc.formatLabel}${desc.group ? ` (${desc.group})` : ""}`;
  } else {
    syncType = `${desc.formatLabel}${desc.group ? ` • ${desc.group}` : ""}`;
  }

  return {
    fileId,
    downloadUrl: utf8DownloadUrl,
    fallbackGzUrl: cand.SubDownloadLink || null,
    releaseName: desc.cleanReleaseName,
    formatLabel: desc.formatLabel,
    syncScore: exactSyncScore || familyRankScore,
    isHashMatch,
    isExactMatch,
    syncType,
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
        "User-Agent": "Mozilla/5.0",
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
    if (!resp.ok) return { status: resp.status, data: null };
    return { status: resp.status, data: await resp.json() };
  } catch (err) {
    return { status: err?.message || "error", data: null };
  }
}
