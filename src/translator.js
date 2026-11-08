/**
 * Parallel Cloudflare Workers AI (`@cf/google/gemma-3-12b-it`) Subtitle Adaptation Pool
 *
 * Pipeline:
 * 1. Parse raw English `.srt` cues via `parseSrt` (`subedit.js`).
 * 2. Run `cleanCueForTranslation` (SubtitleEdit `RemoveTextForHI`, speaker `NAME:` removal,
 *    dialogue dash normalization, unwrap single-speaker 2-line wraps).
 * 3. Drop cues that became empty (pure sound-effect / music / credit cues).
 * 4. Partition remaining cues into scene batches (~30 cues per batch) and run a high-concurrency
 *    worker pool (`Promise.all` across batches) against Cloudflare's native `env.AI.run("@cf/google/gemma-3-12b-it")`
 *    so an entire episode/movie finishes in ~5–10 seconds.
 * 5. Post-process every adapted Hebrew cue with `postProcessHebrewCue` (SubtitleEdit `AutoBreakLine`
 *    with Hebrew `NoBreakAfterList` + Unicode RLM `\u200F` BiDi punctuation fixing).
 */

import {
  parseSrt,
  serializeSrt,
  cleanCueForTranslation,
  postProcessHebrewCue,
} from "./subedit.js";

const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";

const SYSTEM_PROMPT = `You are an expert Israeli subtitle translator and adapter (Ktuvit / Wizdom broadcast standard).
Adapt the provided numbered English subtitle cues into natural, idiomatic, spoken Israeli Hebrew.

STRICT ADAPTATION RULES:
1. Output ONLY the numbered lines in the exact format: [ID] Hebrew text
2. Keep the exact [ID] numbers from the input. Do NOT skip, merge, or invent IDs.
3. Adapt idioms, slang, and phrasing into natural spoken Hebrew (not literal word-for-word translation).
4. Infer speaker and listener gender (male/female/plural) from the surrounding scene context in the batch.
5. If an input cue has two speakers separated by " // " (representing a 2-line dialogue with "- "), output both speakers separated by " // " with "- " before each speaker.
6. Otherwise, write each cue as a single continuous Hebrew line without line breaks (our post-processor will break lines at the optimal Hebrew syntactic marker).
7. Do NOT include any speaker labels (like "JOHN:"), sound effects ("[sighs]"), or explanations.`;

/**
 * Full end-to-end English SRT -> Adapted Israeli Hebrew SRT pipeline.
 */
export async function adaptSrtToHebrew(rawEnglishSrt, env, options = {}) {
  const model = options.model || env?.AI_MODEL || DEFAULT_MODEL;
  const batchSize = parseInt(options.batchSize || env?.BATCH_SIZE || "30", 10);
  const maxConcurrency = parseInt(options.maxConcurrency || env?.MAX_CONCURRENT_BATCHES || "10", 10);
  const singleLineMaxLength = parseInt(
    options.singleLineMaxLength || env?.SINGLE_LINE_MAX_LENGTH || "42",
    10
  );

  // 1. Parse raw English SRT
  const rawCues = parseSrt(rawEnglishSrt);
  if (rawCues.length === 0) {
    throw new Error("Source English SRT contained no valid subtitle cues.");
  }

  // 2. Deterministic SubtitleEdit (`libse`) pre-processing on every cue
  const cleanedCues = [];
  for (const cue of rawCues) {
    const cleanedText = cleanCueForTranslation(cue.text);
    if (!cleanedText) continue; // Cue was 100% HI tag / music / credit watermark -> drop it!

    cleanedCues.push({
      id: cleanedCues.length + 1,
      startTime: cue.startTime,
      endTime: cue.endTime,
      startMs: cue.startMs,
      endMs: cue.endMs,
      englishText: cleanedText,
      hebrewText: "",
    });
  }

  if (cleanedCues.length === 0) {
    throw new Error("All cues were empty after SubtitleEdit HI/SDH cleanup.");
  }

  // 3. Partition into contextual scene batches
  const batches = [];
  for (let i = 0; i < cleanedCues.length; i += batchSize) {
    batches.push(cleanedCues.slice(i, i + batchSize));
  }

  // 4. Execute batches across a concurrent worker pool (`maxConcurrency` in parallel)
  // with a strict time budget (`timeBudgetMs`, default 22000ms) so the HTTP `.srt` request
  // NEVER hits Cloudflare/Stremio's 30s timeout! If `isBackgroundFullPass` is true (`ctx.waitUntil`),
  // it translates 100% of batches without an early cutoff and caches the complete SRT at the edge.
  const timeBudgetMs = options.timeBudgetMs || 22000;
  const startTimeMs = Date.now();
  const translatedMap = new Map();
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

  const workerCount = Math.min(maxConcurrency, batches.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  const isComplete = completedBatches >= batches.length;

  // 5. Post-process every Hebrew cue with SubtitleEdit `AutoBreakLine` + RLM BiDi fixing
  const finalCues = [];
  for (const cue of cleanedCues) {
    const rawHeb = translatedMap.get(cue.id);
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
  };
}

/**
 * Translate a single contextual batch of cues using Cloudflare Workers AI (`@cf/google/gemma-3-12b-it`).
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

  const response = await env.AI.run(model, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 4096,
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
 * Parse `[ID] Hebrew text` lines returned by Gemma 3 12B.
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

  // Fallback alignment if the LLM omitted bracket numbers but returned the exact same number of lines
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
