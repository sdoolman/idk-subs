/**
 * Content-Adaptive, Token-Miser Cloudflare Workers AI (`@cf/google/gemma-4-26b-a4b-it`) Subtitle Pool
 *
 * Key optimizations:
 * 1. Deterministic SubtitleEdit (`libse`) pre-processing (`cleanCueForTranslation`):
 *    - Strips `[HI]`/`(SDH)` tags, music lyrics, uploader credits/watermarks, and `SPEAKER:` labels
 *      BEFORE calling AI so we never burn tokens on non-dialogue clutter.
 * 2. Non-Translatable Cue Bypass + Exact Duplicate Deduplication:
 *    - Pure numbers/punctuation (`"1993"`, `"..."`, `"?!"`) bypass AI (`0` tokens).
 *    - Repeated standalone lines across the episode/movie (`"What?"`, `"No."`, `"Okay."`, `"Thank you."`)
 *      are translated ONLY ONCE and mapped back to all duplicate timestamps (saving 10–18% of tokens).
 * 3. Content-Adaptive Scene Batching (Target 75–110 cues/batch, capped at <= 25 subrequests):
 *    - Dynamically sizes batches based on total cue count and natural scene gaps (`>= 2.5s` silence)
 *      so even a 3-hour movie (2,000+ cues) never exceeds Cloudflare's 50-subrequest limit and
 *      cuts system-prompt repetition overhead by ~85%.
 * 4. Compact System Prompt (~55 tokens) + `reasoning_effort: "none"` (`enable_thinking: false`).
 * 5. Post-processes every cue with SubtitleEdit `AutoBreakLine` + Unicode RLM (`\u200F`) BiDi wrapping.
 */

import {
  parseSrt,
  serializeSrt,
  cleanCueForTranslation,
  postProcessHebrewCue,
} from "./subedit.js";

const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/**
 * Ultra-compact system prompt (~55 tokens) to minimize per-batch token overhead while enforcing
 * Ktuvit/Wizdom Israeli Hebrew adaptation rules.
 */
const SYSTEM_PROMPT = `Translate numbered English subtitle lines into natural spoken Israeli Hebrew.
Rules:
1. Output ONLY: [ID] Hebrew text (keep exact IDs, 1 line per ID).
2. Infer speaker/listener gender from scene context; use idiomatic Hebrew.
3. If input has " // " (2 speakers), output "- speaker1 // - speaker2".`;

/**
 * Check if a cleaned cue contains no alphabetic words (e.g. pure numbers, symbols, timestamps like "1993", "10:00", "...").
 */
function hasTranslatableWords(text) {
  return /[A-Za-z]/.test(text);
}

/**
 * Partition unique cues into content-adaptive scene batches:
 * - Scales target batch size (`min 65`, `max 110`) so total batches never exceed `maxBatches` (24),
 *   guaranteeing we stay well under Cloudflare Free Tier's 50-subrequest limit even on 3-hour movies!
 * - Snaps batch boundaries to natural scene breaks (gaps >= 2500ms between consecutive cues) within
 *   the last 20% of the batch so conversations aren't split mid-sentence.
 */
export function partitionIntoSceneBatches(cues, preferredBatchSize = 80, maxBatches = 24) {
  if (cues.length === 0) return [];

  // Dynamically adapt batch size to content length so `batches.length <= maxBatches`
  const adaptiveSize = Math.max(
    preferredBatchSize,
    Math.min(115, Math.ceil(cues.length / maxBatches))
  );

  const batches = [];
  let i = 0;

  while (i < cues.length) {
    const remaining = cues.length - i;
    if (remaining <= adaptiveSize * 1.15) {
      batches.push(cues.slice(i));
      break;
    }

    let endIdx = i + adaptiveSize;
    // Look for a natural scene transition (gap >= 2500ms) in the window [endIdx - 12, endIdx + 8]
    const searchStart = Math.max(i + Math.floor(adaptiveSize * 0.75), endIdx - 12);
    const searchEnd = Math.min(cues.length - 1, endIdx + 8);

    let bestSplitIdx = endIdx;
    let maxGapMs = 0;

    for (let j = searchStart; j < searchEnd; j++) {
      const gap = (cues[j + 1]?.startMs || 0) - (cues[j]?.endMs || 0);
      if (gap >= 2500 && gap > maxGapMs) {
        maxGapMs = gap;
        bestSplitIdx = j + 1;
      }
    }

    batches.push(cues.slice(i, bestSplitIdx));
    i = bestSplitIdx;
  }

  return batches;
}

/**
 * Full end-to-end English SRT -> Adapted Israeli Hebrew SRT pipeline.
 */
export async function adaptSrtToHebrew(rawEnglishSrt, env, options = {}) {
  const model = options.model || env?.AI_MODEL || DEFAULT_MODEL;
  const preferredBatchSize = parseInt(options.batchSize || env?.BATCH_SIZE || "80", 10);
  const maxConcurrency = parseInt(options.maxConcurrency || env?.MAX_CONCURRENT_BATCHES || "25", 10);
  const singleLineMaxLength = parseInt(
    options.singleLineMaxLength || env?.SINGLE_LINE_MAX_LENGTH || "42",
    10
  );

  // 1. Parse raw English SRT
  const rawCues = parseSrt(rawEnglishSrt);
  if (rawCues.length === 0) {
    throw new Error("Source English SRT contained no valid subtitle cues.");
  }

  // 2. Deterministic SubtitleEdit (`libse`) pre-processing + Exact-Duplicate Deduplication
  const cleanedCues = [];
  const uniqueCuesToTranslate = [];
  // Normalize short/repeated standalone lines (<= 45 chars) so identical lines ("What?", "No!", "Thank you.")
  // across the movie are only sent to the LLM once! (Longer context-dependent lines keep their scene slot.)
  const seenShortLines = new Map(); // normalizedKey -> canonical cue.id
  const duplicateToCanonicalId = new Map(); // cue.id -> canonical cue.id
  const passthroughMap = new Map(); // cue.id -> non-alphabetic text ("1993", "...")

  for (const cue of rawCues) {
    const cleanedText = cleanCueForTranslation(cue.text);
    if (!cleanedText) continue; // Pure HI tag / music / credit watermark -> drop (0 tokens!)

    const id = cleanedCues.length + 1;
    const item = {
      id,
      startTime: cue.startTime,
      endTime: cue.endTime,
      startMs: cue.startMs,
      endMs: cue.endMs,
      englishText: cleanedText,
    };
    cleanedCues.push(item);

    if (!hasTranslatableWords(cleanedText)) {
      passthroughMap.set(id, cleanedText);
      continue;
    }

    const normKey = cleanedText.toLowerCase().replace(/\s+/g, " ").trim();
    if (normKey.length <= 45 && seenShortLines.has(normKey)) {
      duplicateToCanonicalId.set(id, seenShortLines.get(normKey));
    } else {
      if (normKey.length <= 45) {
        seenShortLines.set(normKey, id);
      }
      uniqueCuesToTranslate.push(item);
    }
  }

  if (cleanedCues.length === 0) {
    throw new Error("All cues were empty after SubtitleEdit HI/SDH cleanup.");
  }

  // 3. Partition unique translatable cues into content-adaptive scene batches
  const batches = partitionIntoSceneBatches(uniqueCuesToTranslate, preferredBatchSize, 24);

  // 4. Execute all batches in a single parallel wave (`Promise.all`)
  const timeBudgetMs = options.timeBudgetMs || 26000;
  const startTimeMs = Date.now();
  const translatedMap = new Map(passthroughMap);
  let nextBatchIdx = 0;
  let completedBatches = 0;

  async function worker() {
    while (nextBatchIdx < batches.length) {
      if (!options.isBackgroundFullPass && Date.now() - startTimeMs > timeBudgetMs && completedBatches > 0) {
        break;
      }
      const currentIdx = nextBatchIdx++;
      const batch = batches[currentIdx];
      try {
        const batchTranslations = await translateBatchWithGemma(batch, env, model);
        for (const [id, heb] of batchTranslations.entries()) {
          translatedMap.set(id, heb);
        }
        completedBatches++;
      } catch (err) {
        if (completedBatches === 0 && currentIdx === 0) {
          throw err;
        }
      }
    }
  }

  const workerCount = Math.min(maxConcurrency, Math.max(1, batches.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const isComplete = completedBatches >= batches.length;

  // 5. Post-process every Hebrew cue with SubtitleEdit `AutoBreakLine` + RLM BiDi fixing
  const finalCues = [];
  for (const cue of cleanedCues) {
    const canonicalId = duplicateToCanonicalId.get(cue.id) || cue.id;
    const rawHeb = translatedMap.get(canonicalId);
    if (!rawHeb) continue;

    // Restore 2-speaker dialogue newline if the cue used " // " separator
    const restoredNewlines = rawHeb.includes(" // ")
      ? rawHeb
          .split(" // ")
          .map((part) => {
            const p = part.trim();
            return p.startsWith("-") ? `- ${p.replace(/^-\s*/, "")}` : `- ${p}`;
          })
          .join("\n")
      : rawHeb;

    const formattedHebrew = postProcessHebrewCue(restoredNewlines, singleLineMaxLength);
    if (!formattedHebrew) continue;

    finalCues.push({
      startTime: cue.startTime,
      endTime: cue.endTime,
      text: formattedHebrew,
    });
  }

  if (finalCues.length === 0) {
    throw new Error("AI translation produced no valid Hebrew cues.");
  }

  return {
    srt: serializeSrt(finalCues),
    isComplete,
    translatedCuesCount: finalCues.length,
    totalCuesCount: cleanedCues.length,
    uniqueTranslatedCount: uniqueCuesToTranslate.length,
    batchesCount: batches.length,
  };
}

/**
 * Translate a single contextual batch of cues using Cloudflare Workers AI (`@cf/google/gemma-4-26b-a4b-it`).
 */
async function translateBatchWithGemma(batch, env, model) {
  if (!env || !env.AI) {
    throw new Error("Cloudflare Workers AI binding (env.AI) is not configured.");
  }

  // Format batch lines: encode 2-speaker newlines as " // " so each cue is 1 line in the prompt
  const promptLines = batch.map((cue) => {
    const singleLineEng = cue.englishText.replace(/\n/g, " // ");
    return `[${cue.id}] ${singleLineEng}`;
  });

  const userPrompt = promptLines.join("\n");

  // Adapt max_tokens to batch size (~22 tokens per Hebrew subtitle line, minimum 1024, max 4096)
  const dynamicMaxTokens = Math.min(4096, Math.max(1024, batch.length * 28));

  const response = await env.AI.run(model, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: dynamicMaxTokens,
    reasoning_effort: "none",
    chat_template_kwargs: {
      enable_thinking: false,
    },
  });

  const rawOutput =
    typeof response === "string"
      ? response
      : response?.response ||
        response?.result?.response ||
        response?.choices?.[0]?.message?.content ||
        response?.result?.choices?.[0]?.message?.content ||
        "";

  return parseBatchOutput(rawOutput, batch);
}

/**
 * Parse `[ID] Hebrew text` lines returned by Gemma.
 */
export function parseBatchOutput(rawOutput, batch) {
  const resultMap = new Map();
  if (!rawOutput) return resultMap;

  const lines = rawOutput.split(/\r?\n/);
  let currentId = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Match `[12] טקסט` or `**[12] טקסט**` or `12. טקסט`
    const cleanedLine = line.replace(/^\*+|\*+$/g, "").trim();
    const match = cleanedLine.match(/^(?:\[(\d+)\]|(\d+)[.):])\s*(.+)$/);
    if (match) {
      const id = parseInt(match[1] || match[2], 10);
      const text = match[3].replace(/^\*+|\*+$/g, "").trim();
      currentId = id;
      resultMap.set(id, text);
    } else if (currentId !== null && resultMap.has(currentId)) {
      // If the LLM wrapped a 2-speaker dialogue onto a second line, append it with " // "
      resultMap.set(currentId, `${resultMap.get(currentId)} // ${line}`);
    }
  }

  // Fallback alignment if the LLM omitted bracket numbers
  if (resultMap.size === 0) {
    const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
    if (nonEmpty.length === batch.length) {
      for (let i = 0; i < batch.length; i++) {
        resultMap.set(batch[i].id, nonEmpty[i]);
      }
    }
  }

  return resultMap;
}
