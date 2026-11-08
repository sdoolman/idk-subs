/**
 * Direct TypeScript/ES Module port of Nikse's SubtitleEdit (`libse`) core algorithms:
 * - `RemoveTextForHI.cs`: Hearing Impaired (HI/SDH) tag removal, speaker `NAME:` colon removal,
 *   dialogue dash normalization, all-uppercase sound-effect line removal, music symbol stripping,
 *   and interjection removal.
 * - `Utilities.cs` & `TextSplit.cs`: `RemoveLineBreaks`, `CanBreak`, `GetBreakCost`, and `AutoBreakLine`
 *   with Hebrew construct-state / preposition `NoBreakAfterList` rules.
 * - `Utilities.cs`: `FixRtlViaUnicodeChars` + Unicode Right-to-Left Mark (`\u200F` / RLM) injection
 *   for Stremio cross-platform subtitle players (libmpv, ExoPlayer, Web).
 */

const RLM = "\u200F";
const RLE = "\u202B";
const PDF = "\u202C";

const EN_DASH = "\u2013";
const EM_DASH = "\u2014";

/**
 * SubtitleEdit `HiDescriptionWords` from `RemoveTextForHI.cs` + common SDH verbs/nouns
 */
const HI_DESCRIPTION_WORDS = new Set([
  "breathes",
  "breathes deeply",
  "cackles",
  "cheers",
  "chitters",
  "chuckles",
  "clears throat",
  "coughs",
  "cries",
  "exclaims",
  "exhales",
  "explosion",
  "gasps",
  "giggles",
  "groans",
  "growls",
  "grunts",
  "inhales",
  "laughs",
  "moans",
  "mutters",
  "noise",
  "pants",
  "roars",
  "scoff",
  "scoffs",
  "screams",
  "screeches",
  "shouts",
  "shrieks",
  "sigh",
  "sighs",
  "sniffs",
  "snorts",
  "snores",
  "sobs",
  "stammers",
  "stutters",
  "thuds",
  "trumpets",
  "weeps",
  "whisper",
  "whispers",
  "whistles",
  "yells",
]);

/**
 * SubtitleEdit Uppercase Whitelist (`GetUppercaseWhitelist` in `RemoveTextForHI.cs`)
 * Words that can appear alone in uppercase without being an SDH sound effect.
 */
const UPPERCASE_WHITELIST = new Set([
  "I",
  "OK",
  "OKAY",
  "TV",
  "AI",
  "CIA",
  "FBI",
  "NSA",
  "DNA",
  "USA",
  "UK",
  "UN",
  "EU",
  "VIP",
  "CEO",
  "SOS",
  "NO",
  "YES",
  "STOP",
  "RUN",
  "HELP",
  "WAIT",
  "WHAT",
  "WHY",
  "HEY",
  "HI",
  "OH",
  "AH",
  "WOW",
  "MOM",
  "DAD",
]);

/**
 * Common scene credit / watermark substrings (`RemoveIfTextContains` in SubtitleEdit)
 */
const CREDIT_PATTERNS = [
  /subtitles?\s+by\b/i,
  /synced\s+and\s+corrected\s+by/i,
  /resync\s+by\b/i,
  /opensubtitles\.org/i,
  /subdl\.com/i,
  /addic7ed\.com/i,
  /www\.podnapisi/i,
  /yts\.mx|yify/i,
  /support\s+us\s+and\s+become\s+vip/i,
  /advertise\s+your\s+product\s+or\s+brand/i,
];

/**
 * Hebrew `NoBreakAfterList` (ported from SubtitleEdit's `NoBreakAfterList` concept for Hebrew syntax).
 * Never break a line immediately after prepositions, particles, construct-state markers, or negations.
 */
const HEBREW_NO_BREAK_AFTER = new Set([
  "את",
  "של",
  "על",
  "עם",
  "אל",
  "מן",
  "לא",
  "אל",
  "אין",
  "יש",
  "גם",
  "רק",
  "כל",
  "כמו",
  "בלי",
  "לפני",
  "אחרי",
  "נגד",
  "תחת",
  "בין",
  "ליד",
  "מול",
  "عבור",
  "עבור",
  "בשביל",
  "בגלל",
  "למרות",
  "כדי",
  "שלא",
  "שאין",
  "שלא",
  "הזה", // keep with preceding noun if short, or don't leave hanging
  "מר",
  "גברת",
  "ד\"ר",
  "ד״ר",
  "פרופ'",
]);

/**
 * Hebrew conjunctions/subordinators where breaking *before* them reads very naturally (bonus in `GetBreakCost`).
 */
const HEBREW_BREAK_BEFORE_WORDS = new Set([
  "אבל",
  "אולם",
  "אלא",
  "אם",
  "אפילו",
  "אף",
  "אשר",
  "בגלל",
  "בזמן",
  "ברגע",
  "גם",
  "ואז",
  "ואילו",
  "אבל",
  "כאשר",
  "כדי",
  "כי",
  "כיוון",
  "כל",
  "כמו",
  "למרות",
  "לפני",
  "מאז",
  "מפני",
  "משום",
  "עד",
  "عل",
  "פה",
  "שם",
]);

/**
 * Parse an SRT string into an array of subtitle paragraphs:
 * `{ index: number, startTime: string, endTime: string, startMs: number, endMs: number, text: string }`
 */
export function parseSrt(srtContent) {
  if (!srtContent || typeof srtContent !== "string") return [];
  const normalized = srtContent
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const blocks = normalized.split(/\n{2,}/);
  const cues = [];

  for (const rawBlock of blocks) {
    const lines = rawBlock.trim().split("\n");
    if (lines.length < 2) continue;

    let timeLineIdx = 0;
    if (!lines[0].includes("-->") && lines[1] && lines[1].includes("-->")) {
      timeLineIdx = 1;
    } else if (!lines[0].includes("-->")) {
      continue;
    }

    const timeLine = lines[timeLineIdx].trim();
    const match = timeLine.match(
      /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/
    );
    if (!match) continue;

    const startTime = normalizeTimestamp(match[1]);
    const endTime = normalizeTimestamp(match[2]);
    const text = lines
      .slice(timeLineIdx + 1)
      .join("\n")
      .trim();

    if (!text) continue;

    cues.push({
      index: cues.length + 1,
      startTime,
      endTime,
      startMs: timestampToMs(startTime),
      endMs: timestampToMs(endTime),
      text,
    });
  }

  return cues;
}

function normalizeTimestamp(ts) {
  const [hms, ms = "000"] = ts.replace(".", ",").split(",");
  const parts = hms.split(":");
  const hh = (parts[0] || "00").padStart(2, "0");
  const mm = (parts[1] || "00").padStart(2, "0");
  const ss = (parts[2] || "00").padStart(2, "0");
  const mmm = ms.padEnd(3, "0").slice(0, 3);
  return `${hh}:${mm}:${ss},${mmm}`;
}

export function timestampToMs(ts) {
  const [hms, ms] = ts.split(",");
  const [hh, mm, ss] = hms.split(":").map(Number);
  return ((hh * 3600 + mm * 60 + ss) * 1000) + Number(ms || 0);
}

/**
 * Serialize cues back into standard SubRip (.srt) format.
 */
export function serializeSrt(cues) {
  const out = [];
  let idx = 1;
  for (const cue of cues) {
    const text = (cue.text || "").trim();
    if (!text) continue;
    out.push(`${idx}\r\n${cue.startTime} --> ${cue.endTime}\r\n${text}`);
    idx++;
  }
  return out.join("\r\n\r\n") + "\r\n";
}

/**
 * Strip HTML tags (`<i>`, `<b>`, `<font...>`, ASSA `{\an8}`) while optionally preserving `<i>`.
 */
export function removeHtmlTags(text, alsoRemoveAssa = true) {
  if (!text) return "";
  let s = text;
  if (alsoRemoveAssa) {
    s = s.replace(/\{\\[^}]*\}/g, "");
  }
  return s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

function isAllUppercase(text) {
  const clean = removeHtmlTags(text, true).trim();
  if (!clean) return false;
  let hasLetters = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch >= "a" && ch <= "z") return false;
    if (ch >= "A" && ch <= "Z") hasLetters = true;
  }
  return hasLetters;
}

function isHiDescription(text) {
  const clean = text
    .replace(/^[(\[{?\s-]+|[)\]}?\s-]+$/g, "")
    .toLowerCase()
    .trim();
  if (!clean) return false;
  return (
    HI_DESCRIPTION_WORDS.has(clean) ||
    clean.startsWith("engine ") ||
    clean.endsWith(" on tv") ||
    clean.endsWith(" on radio") ||
    clean.endsWith(" over intercom") ||
    clean.endsWith(" shatters") ||
    clean.endsWith("ing")
  );
}

/**
 * Port of SubtitleEdit's `FindMatchingEndTag` & `RemoveTextBetweenTags` (`RemoveTextForHI.cs` L1821-1915).
 * Properly handles nested brackets like `(WOMAN (V.O.)): Where are you?`.
 */
function findMatchingEndTag(text, start, startTag, endTag) {
  if (startTag === endTag) {
    return text.indexOf(endTag, start + startTag.length);
  }
  let depth = 1;
  let i = start + startTag.length;
  while (i < text.length) {
    if (text.startsWith(startTag, i)) {
      depth++;
      i += startTag.length;
      continue;
    }
    if (text.startsWith(endTag, i)) {
      depth--;
      if (depth === 0) return i;
      i += endTag.length;
      continue;
    }
    i++;
  }
  return -1;
}

export function removeTextBetweenTags(startTag, endTag, text) {
  let s = text.trim();
  let start = s.indexOf(startTag);
  while (start >= 0 && s.length - start - startTag.length >= endTag.length) {
    const end = findMatchingEndTag(s, start, startTag, endTag);
    if (end < 0) break;

    s = s.slice(0, start) + s.slice(end + endTag.length);
    if (
      start > 3 &&
      s.length - start > 1 &&
      s[start] === ":" &&
      s[start - 1] === " " &&
      ".?!".includes(s[start - 2])
    ) {
      s = s.slice(0, start - 1) + s.slice(start + 1);
    } else if (start === 0 && s.length > 0 && s[0] === ":") {
      s = s.slice(1).trimStart();
    }
    start = s.indexOf(startTag);
  }
  return s.replace(/ {2,}/g, " ").trim();
}

/**
 * Port of SubtitleEdit's `IsInsideBrackets` (`RemoveTextForHI.cs` L954).
 */
function isInsideBrackets(text, targetIndex) {
  const openParen = text.lastIndexOf("(", targetIndex - 1);
  if (openParen >= 0 && text.indexOf(")", openParen) > targetIndex) return true;
  const openSquare = text.lastIndexOf("[", targetIndex - 1);
  if (openSquare >= 0 && text.indexOf("]", openSquare) > targetIndex) return true;
  return false;
}

/**
 * Port of SubtitleEdit's `ShouldRemoveNarrator` (`RemoveTextForHI.cs` L972).
 * Avoids stripping colons that are part of normal sentences, URLs, or timestamps.
 */
const NARRATOR_SKIP_WORDS = [
  "choose",
  "example",
  "following",
  "follows",
  "include",
  "including",
  "listen",
  "like",
  "mean",
  "means",
  "message",
  "mission",
  "note",
  "order",
  "question",
  "remember",
  "rule",
  "said",
  "say",
  "saying",
  "says",
  "secret",
  "step",
  "tell",
  "telling",
  "tells",
  "that",
  "the",
  "these",
  "thing",
  "things",
  "this",
  "those",
  "truth",
  "word",
  "words",
  "wrote",
];

function shouldRemoveNarrator(pre) {
  const clean = removeHtmlTags(pre, true).replace(/^[\s\-–—"'`]+/, "").trim();
  if (!clean || clean.length > 30) return false;
  if (/https?|www\./i.test(clean)) return false;
  if (/[?!;,"]/.test(clean)) return false;

  const lower = clean.toLowerCase();
  const words = lower.split(/\s+/);
  // Speaker tags are usually 1-3 words (e.g. "JOHN:", "MAN 1:", "OLD WOMAN:", "NARRATOR:")
  if (words.length > 3) return false;

  for (const w of words) {
    if (NARRATOR_SKIP_WORDS.includes(w)) return false;
  }

  // Either uppercase speaker ("JOHN:", "MAN #1:") or Title Case speaker ("John:", "Dr. Smith:")
  const isUpper = isAllUppercase(clean);
  const isTitleCase = words.every(
    (w) => /^[A-Z][a-z0-9.#-]*$/.test(w) || /^(mr|mrs|ms|dr|prof|capt|lt|sgt|gen)\.?$/i.test(w)
  );
  return isUpper || isTitleCase || isHiDescription(clean);
}

/**
 * Port of SubtitleEdit's `RemoveColon` (`RemoveTextForHI.cs` L174-819).
 * Strips speaker labels (`JOHN:`, `- [SARAH]:`, `MAN 1:`) and mid-line speaker shifts
 * (`Hello there. JOHN: General Kenobi.`) while preserving dialogue dashes (`- `) when 2 speakers talk!
 */
export function removeSpeakerColons(text) {
  if (!text || !text.includes(":")) return text;

  const lines = text.split("\n");
  const processedLines = [];
  let namesRemovedCount = 0;
  const removedOnLine = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    let lineHadSpeakerRemoved = false;

    // 1. Handle mid-line speaker after sentence ending: "Wait here. SARAH: No way!"
    line = line.replace(
      /([.?!]["']?\s+)(?:-\s*)?([A-Z][A-Z0-9\s.#-]{1,22}):\s+/g,
      (match, punct, speaker) => {
        if (shouldRemoveNarrator(speaker)) {
          namesRemovedCount++;
          lineHadSpeakerRemoved = true;
          return `${punct}\n- `;
        }
        return match;
      }
    );

    // If mid-line split created two lines, process each sub-line
    const subLines = line.split("\n");
    for (let sub of subLines) {
      sub = sub.trim();
      const colonIdx = sub.indexOf(":");
      if (colonIdx > 0 && !isInsideBrackets(sub, colonIdx)) {
        // Don't touch timestamps / ratios like 12:30
        const beforeChar = sub[colonIdx - 1];
        const afterChar = sub[colonIdx + 1] || "";
        const isBetweenNumbers = /\d/.test(beforeChar) && /\d/.test(afterChar);

        if (!isBetweenNumbers) {
          const pre = sub.slice(0, colonIdx);
          const post = sub.slice(colonIdx + 1).trim();

          // Check if entire line is just a trailing speaker header like "UNA:"
          if (!post && isAllUppercase(pre) && shouldRemoveNarrator(pre)) {
            namesRemovedCount++;
            lineHadSpeakerRemoved = true;
            continue;
          }

          if (post && shouldRemoveNarrator(pre)) {
            const hadLeadingDash = /^\s*(?:<[^>]+>\s*)*[-–—]/.test(pre);
            namesRemovedCount++;
            lineHadSpeakerRemoved = true;
            // Capitalize first letter if needed
            const capPost = post.replace(/^([a-z])/, (m) => m.toUpperCase());
            sub = hadLeadingDash ? `- ${capPost}` : capPost;
          }
        }
      }
      if (sub) {
        processedLines.push(sub);
        removedOnLine.push(lineHadSpeakerRemoved);
      }
    }
  }

  if (processedLines.length === 0) return "";

  // SubtitleEdit dialogue dash insertion rule (`RemoveTextForHI.cs` L596-686):
  // If 2 lines remain and at least one speaker name was removed (and line 1 ends a sentence or line 2 had a speaker),
  // ensure both lines have leading dialogue dashes (`- `) so the viewer knows two people are speaking!
  if (processedLines.length === 2 && namesRemovedCount >= 1) {
    const l0Clean = removeHtmlTags(processedLines[0], true).replace(/["']+$/, "").trim();
    const l1Clean = removeHtmlTags(processedLines[1], true).trim();
    const l0EndsSentence = l0Clean.length > 0 && /[.?!…—-]$/.test(l0Clean);
    const bothHadSpeakers = removedOnLine[0] && removedOnLine[1];
    const secondHadSpeaker = removedOnLine[1] && l0EndsSentence;
    const secondHasDash = /^[-–—]/.test(l1Clean);

    if (bothHadSpeakers || secondHadSpeaker || (removedOnLine[0] && secondHasDash && l0EndsSentence)) {
      if (!/^(\s*<[^>]+>)*\s*-\s/.test(processedLines[0])) {
        processedLines[0] = `- ${processedLines[0].replace(/^[-–—]\s*/, "")}`;
      }
      if (!/^(\s*<[^>]+>)*\s*-\s/.test(processedLines[1])) {
        processedLines[1] = `- ${processedLines[1].replace(/^[-–—]\s*/, "")}`;
      }
    }
  }

  // Conversely, if a 2-line dialog collapsed into 1 line because the other line was an HI tag,
  // strip the orphaned leading dialog dash (`RemoveTextForHI.cs` L687-694 & L1256-1303).
  if (processedLines.length === 1) {
    processedLines[0] = processedLines[0].replace(/^(\s*<[^>]+>)*\s*[-–—]\s+/, "$1");
  }

  return processedLines.join("\n").trim();
}

/**
 * Port of SubtitleEdit's `RemoveTextFromHearImpaired` (`RemoveTextForHI.cs` L1010-1388).
 * Cleans a single cue's text of all HI/SDH clutter, music lyrics, speaker names, and empty tags.
 */
export function cleanCueForTranslation(input) {
  if (!input) return "";

  // 1. Check scene/credit watermarks
  for (const rx of CREDIT_PATTERNS) {
    if (rx.test(input)) return "";
  }

  // Normalize unicode dashes and spaces
  let text = input
    .replace(/\u00A0/g, " ")
    .replace(/\u2010/g, "-")
    .replace(/\{\\[^}]*\}/g, ""); // Strip ASSA override tags like {\an8}

  // Strip HTML formatting tags early so LLM doesn't hallucinate broken tags
  text = removeHtmlTags(text, true);

  // 2. If cue contains music symbols (♪ / ♫ / #), drop music lines (`RemoveIfOnlyMusicSymbols`)
  const rawLines = text.split("\n");
  const nonMusicLines = rawLines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/[♪♫]/.test(t)) return false;
    if (/^#.*#$/.test(t)) return false;
    return true;
  });
  if (nonMusicLines.length === 0) return "";
  text = nonMusicLines.join("\n");

  // 3. Remove `[...]:`, `(...):`, `{...}:`, `[...]`, `(...)`, `{...}` (nested-aware)
  text = removeTextBetweenTags("[", "]:", text);
  text = removeTextBetweenTags("[", "]", text);
  text = removeTextBetweenTags("{", "}:", text);
  text = removeTextBetweenTags("{", "}", text);
  text = removeTextBetweenTags("(", "):", text);
  text = removeTextBetweenTags("(", ")", text);

  //Also remove multi-line spanning brackets (e.g., `[man shouting\nin distance]`)
  text = text.replace(/\[[^\]]*\]/gs, "").replace(/\([^)]*\)/gs, "");

  if (!text.trim()) return "";

  // 4. Normalize leading en/em dialog dashes (`ReplaceLeadingDialogDashes` in `RemoveTextForHI.cs` L1430)
  const linesForDash = text.split("\n");
  if (linesForDash.length >= 2) {
    for (let i = 0; i < linesForDash.length; i++) {
      linesForDash[i] = linesForDash[i].replace(/^\s*[–—]\s*/, "- ");
    }
    text = linesForDash.join("\n");
  }

  // 5. Remove Speaker Colons (`RemoveColon`)
  text = removeSpeakerColons(text);
  if (!text.trim()) return "";

  // 6. Remove ALL-CAPS sound effect lines (`RemoveLineIfAllUppercase` in `RemoveTextForHI.cs` L1917)
  const remainingLines = [];
  for (let line of text.split("\n")) {
    line = line.replace(/ {2,}/g, " ").trim();
    if (!line || line === "-" || line === "--") continue;

    // Check if the line is an all-caps non-whitelisted cue (like "THUNDER RUMBLES" or "GUNSHOT")
    if (isAllUppercase(line)) {
      const bare = line.replace(/^[-\s"'‘“]+|[.!?:,;"'’”\s-]+$/g, "").trim();
      // Keep single short interjections/acronyms in whitelist or multi-sentence shouting with !/?
      const isWhitelisted = bare.length <= 1 || UPPERCASE_WHITELIST.has(bare);
      const isShoutingDialogue =
        (line.endsWith("!") || line.endsWith("?")) &&
        !isHiDescription(bare) &&
        /\b(I|YOU|WE|HE|SHE|THEY|IT|NO|DON'T|STOP|GET|GO|WHAT|WHERE|WHO|WHY|HOW)\b/.test(bare);
      if (!isWhitelisted && !isShoutingDialogue) {
        continue;
      }
    }

    // Strip orphaned HI description if a whole line is just "sighs" or "laughs"
    if (isHiDescription(line)) continue;

    remainingLines.push(line);
  }

  if (remainingLines.length === 0) return "";

  // 7. If a 2-line dialogue was reduced to 1 single-speaker line, strip leading dialogue dash
  if (remainingLines.length === 1) {
    remainingLines[0] = remainingLines[0].replace(/^-\s+/, "").trim();
  }

  // 8. Unwrap artificial English line breaks (`RemoveLineBreaks` in `Utilities.cs` L834)
  // UNLESS this is a genuine 2-speaker dialogue (`- Speaker 1\n- Speaker 2`)!
  if (remainingLines.length >= 2) {
    const isMultiSpeakerDialog =
      remainingLines.slice(1).some((l) => /^-\s/.test(l)) ||
      (remainingLines[0].startsWith("- ") && remainingLines[1].startsWith("- "));

    if (isMultiSpeakerDialog) {
      return remainingLines
        .map((l) => (l.startsWith("-") ? `- ${l.replace(/^-\s*/, "")}` : l))
        .join("\n")
        .trim();
    } else {
      // Single speaker across 2 English lines -> unwrap into 1 clean sentence for AI adaptation!
      return remainingLines.join(" ").replace(/ {2,}/g, " ").trim();
    }
  }

  return remainingLines[0].trim();
}

/**
 * Port of SubtitleEdit's `CanBreak` and `GetBreakCost` (`Utilities.cs` L267-568)
 * tailored specifically for Hebrew (`language = "he"`).
 */
export function canBreakHebrew(text, spaceIndex) {
  if (spaceIndex <= 0 || spaceIndex >= text.length - 1) return false;
  if (text[spaceIndex] !== " ") return false;

  const head = text.slice(0, spaceIndex).trim();
  const tail = text.slice(spaceIndex + 1).trim();
  if (!head || !tail) return false;

  // Never leave a 1-character word orphaned at start or end
  if (head.length <= 1 || tail.length <= 1) return false;

  // Extract last word before the space (stripping leading prefixes like ו/ש/כ/ב/ל/מ/ה or quotes)
  const lastSpaceInHead = head.lastIndexOf(" ");
  const lastWordRaw = lastSpaceInHead >= 0 ? head.slice(lastSpaceInHead + 1) : head;
  const lastWordClean = lastWordRaw.replace(/^["'״׳(\[-]+/, "");

  // If the word before the space ends with punctuation (comma, period, etc.), we CAN break!
  if (/[,.;:?!…—–]$/.test(lastWordClean)) {
    // Exception: abbreviations like ד"ר / מר.
    if (/^(מר|גב|דר|פרופ)\.$/.test(lastWordClean)) return false;
    return true;
  }

  // Check Hebrew NoBreakAfterList (prepositions, construct markers, negations)
  if (HEBREW_NO_BREAK_AFTER.has(lastWordClean)) {
    return false;
  }
  // Also check with attached conjunction prefix `ו` / `ש` / `כש` (e.g., `ואת`, `שעל`, `ובלי`, `שלא`)
  if (
    lastWordClean.length >= 3 &&
    /^[ושכבלמה]/.test(lastWordClean) &&
    HEBREW_NO_BREAK_AFTER.has(lastWordClean.slice(1))
  ) {
    return false;
  }

  // Do not break between two numbers or a number and "%" / "$"
  const firstWordInTail = tail.split(" ")[0];
  if (/^\d+$/.test(lastWordClean) && /^(\d+|%|דולר|שקל|ש"ח|ש״ח|שנים|שעות|דקות)/.test(firstWordInTail)) {
    return false;
  }

  return true;
}

/**
 * Port of SubtitleEdit's `GetBreakCost` (`Utilities.cs` L526-568) + `TextSplit.cs`
 * Calculates the cost of breaking `text` at `spaceIndex`.
 * Lower cost = better split.
 */
function getHebrewBreakCost(text, spaceIndex) {
  const l1 = text.slice(0, spaceIndex).trim();
  const l2 = text.slice(spaceIndex + 1).trim();

  // Base cost: squared difference in line lengths (SubtitleEdit's `514: 2 * d * d` formulation)
  const avg = (l1.length + l2.length) / 2;
  const lengthDiffCost = (l1.length - avg) ** 2 + (l2.length - avg) ** 2;

  let bonus = 0;

  if (!canBreakHebrew(text, spaceIndex)) {
    bonus += 1000000; // `NoBreakCost` in `Utilities.cs` L512
  }

  // Dialog dash on second line (`BreakBeforeDialogBonus = 100` in `Utilities.cs` L517)
  if (l2.startsWith("- ") || l2.startsWith("– ")) {
    bonus -= 180;
  }

  // Check last non-quote character of Line 1
  const l1Trimmed = l1.replace(/["'״׳)\]]+$/, "");
  const lastChar = l1Trimmed[l1Trimmed.length - 1] || "";

  if (".?!…".includes(lastChar)) {
    // Check it's not a decimal number like 3.5
    const isDecimal =
      lastChar === "." &&
      l1Trimmed.length >= 2 &&
      /\d/.test(l1Trimmed[l1Trimmed.length - 2]) &&
      /^\d/.test(l2);
    if (!isDecimal) {
      bonus -= 100; // `BreakAfterSentenceEndBonus`
    }
  } else if (",;:—–".includes(lastChar)) {
    bonus -= 55; // `BreakAfterCommaBonus`
  }

  // Hebrew syntactic bonus: breaking right BEFORE a Hebrew conjunction/subordinator (`אבל`, `כי`, `אם`, `ש...`, `ו...`)
  const firstWordInL2 = l2.split(" ")[0].replace(/^["'״׳]+/, "");
  if (HEBREW_BREAK_BEFORE_WORDS.has(firstWordInL2)) {
    bonus -= 35;
  } else if (firstWordInL2.length >= 3 && /^[וש]/.test(firstWordInL2)) {
    // Words starting with ש... (that/which) or ו... (and) are natural clause boundaries in Hebrew
    bonus -= 15;
  }

  // Slight preference for bottom-heavy / balanced pyramid (`AutoBreakPreferBottomHeavy` in `TextSplit.cs` L130)
  if (l2.length >= l1.length && l2.length - l1.length <= 8) {
    bonus -= 6;
  }

  return lengthDiffCost + bonus;
}

/**
 * Port of SubtitleEdit's `AutoBreakLine` (`Utilities.cs` L617-777 & `TextSplit.cs`).
 * Breaks Hebrew text into at most 2 well-proportioned lines at natural syntactic markers.
 */
export function autoBreakHebrewLine(input, singleLineMaxLength = 42) {
  if (!input || input.length < 3) return input || "";

  let text = input.replace(/\u00A0/g, " ").trim();
  const lines = text
    .split("\n")
    .map((l) => l.replace(/ {2,}/g, " ").trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  // Preserve 2-line dialog (`AutoBreakLinePrivate` L634-683: do not merge genuine 2-speaker dialogs)
  if (lines.length === 2) {
    const l0 = lines[0];
    const l1 = lines[1];
    if ((l0.startsWith("-") && l1.startsWith("-")) || l1.startsWith("- ") || l1.startsWith("-")) {
      const normalizedL0 = l0.startsWith("-") ? `- ${l0.replace(/^-\s*/, "")}` : `- ${l0}`;
      const normalizedL1 = `- ${l1.replace(/^-\s*/, "")}`;
      return `${normalizedL0}\n${normalizedL1}`;
    }
  }

  // Collapse single-speaker lines into a single string first (`RemoveLineBreaks`)
  const collapsed = lines.join(" ").replace(/ {2,}/g, " ").trim();

  // If there is an inline dialog dash (`Hello. - Hi there.`), always split at the dialog dash (`AutoBreakDashEarly`)
  const dialogSplitMatch = collapsed.match(/^(.+?[.?!…]["'״׳]?)\s+-\s+(.+)$/);
  if (dialogSplitMatch) {
    const speaker1 = dialogSplitMatch[1].startsWith("-")
      ? `- ${dialogSplitMatch[1].replace(/^-\s*/, "")}`
      : `- ${dialogSplitMatch[1]}`;
    const speaker2 = `- ${dialogSplitMatch[2].replace(/^-\s*/, "")}`;
    return `${speaker1}\n${speaker2}`;
  }

  // If the line fits within `singleLineMaxLength` (default 42 chars for Hebrew), keep it as 1 line!
  if (collapsed.length <= singleLineMaxLength || !collapsed.includes(" ")) {
    return collapsed;
  }

  // Evaluate all candidate space positions using SubtitleEdit's `TextSplit` algorithm
  let bestSplit = null;
  let bestCost = Infinity;

  let bestValidLengthSplit = null;
  let bestValidLengthCost = Infinity;

  for (let i = 1; i < collapsed.length - 1; i++) {
    if (collapsed[i] !== " ") continue;

    const l1 = collapsed.slice(0, i).trim();
    const l2 = collapsed.slice(i + 1).trim();
    const cost = getHebrewBreakCost(collapsed, i);

    if (l1.length <= singleLineMaxLength && l2.length <= singleLineMaxLength) {
      if (cost < bestValidLengthCost) {
        bestValidLengthCost = cost;
        bestValidLengthSplit = `${l1}\n${l2}`;
      }
    }

    if (cost < bestCost) {
      bestCost = cost;
      bestSplit = `${l1}\n${l2}`;
    }
  }

  return bestValidLengthSplit || bestSplit || collapsed;
}

/**
 * Fix Hebrew RTL BiDi punctuation rendering for Stremio across all platforms (libmpv, ExoPlayer, Web).
 * Combines SubtitleEdit's Unicode directional approach (`FixRtlViaUnicodeChars`) with explicit
 * Right-to-Left Marks (`\u200F` / RLM) at the start and end of every line containing Hebrew characters.
 *
 * Why RLM at both start and end?
 * - Leading `- ` (dialogue dash) or `"quote` or numbers at the start of a line are neutral/weak characters
 *   in the Unicode BiDi algorithm; prefixing `\u200F` forces the dash `- ` to anchor on the RIGHT side!
 * - Trailing `.`, `?`, `!`, `,`, `...`, `"` at the end of a line are neutral characters; appending `\u200F`
 *   forces trailing punctuation to appear on the LEFT end of the Hebrew sentence instead of jumping to the right!
 */
export function fixHebrewRtlPunctuation(input) {
  if (!input) return "";

  // Strip any existing directional marks so we never stack duplicates (`Utilities.cs` L3176)
  const clean = input.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");

  return clean
    .split("\n")
    .map((rawLine) => {
      let line = rawLine.trim();
      if (!line) return "";

      // Only apply RTL marks if the line contains at least one Hebrew character
      if (!/[\u0590-\u05FF]/.test(line)) {
        return line;
      }

      // Normalize dialogue dash spacing
      if (line.startsWith("-") && !line.startsWith("- ") && !line.startsWith("--")) {
        line = `- ${line.slice(1).trimStart()}`;
      }

      // Wrap in RLM (\u200F) at both boundaries so leading `- ` and trailing `.?!”` anchor in RTL context
      return `${RLM}${line}${RLM}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Full post-processing pipeline applied to every translated Hebrew cue:
 * 1. Strip any accidental speaker labels or HI tags the AI might have echoed
 * 2. Run SubtitleEdit `AutoBreakLine` with Hebrew syntactic rules (`singleLineMaxLength = 42`)
 * 3. Apply `fixHebrewRtlPunctuation` (`\u200F`)
 */
export function postProcessHebrewCue(hebrewText, singleLineMaxLength = 42) {
  if (!hebrewText) return "";

  let s = removeHtmlTags(hebrewText, true)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/^\s*\d+\s*[.):-]\s*/, "") // strip accidental numbered list prefix if LLM added one
    .trim();

  if (!s) return "";

  s = autoBreakHebrewLine(s, singleLineMaxLength);
  s = fixHebrewRtlPunctuation(s);
  return s;
}
