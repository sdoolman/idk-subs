import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSrt,
  cleanCueForTranslation,
  autoBreakHebrewLine,
  fixHebrewRtlPunctuation,
  postProcessHebrewCue,
} from "../src/subedit.js";
import {
  parseReleaseMetadata,
  scoreSubtitleSync,
} from "../src/sources.js";

describe("SubtitleEdit (libse) Pre-Processing Port", () => {
  it("strips [HI] and (SDH) tags, nested tags, and music cues completely", () => {
    assert.equal(cleanCueForTranslation("[sighs]"), "");
    assert.equal(cleanCueForTranslation("♪ Always look on the bright side of life ♪"), "");
    assert.equal(
      cleanCueForTranslation("(WOMAN (V.O.)): Where are you going?\n[door slams]"),
      "Where are you going?"
    );
  });

  it("removes speaker colons while inserting dialogue dashes for 2 speakers", () => {
    const input = "JOHN: Are we ready?\nSARAH: Almost there.";
    const cleaned = cleanCueForTranslation(input);
    assert.equal(cleaned, "- Are we ready?\n- Almost there.");
  });

  it("unwraps artificial 2-line single-speaker English wraps into 1 sentence for AI adaptation", () => {
    const input = "I told you we shouldn't\nhave come to this place.";
    assert.equal(
      cleanCueForTranslation(input),
      "I told you we shouldn't have come to this place."
    );
  });

  it("preserves legitimate colons in times and sentences", () => {
    const input = "Meet me at 12:30 sharp.";
    assert.equal(cleanCueForTranslation(input), "Meet me at 12:30 sharp.");
  });
});

describe("SubtitleEdit (libse) Hebrew AutoBreakLine & RTL Punctuation Port", () => {
  it("keeps Hebrew lines <= 42 chars on a single line", () => {
    const heb = "אני לא חושב שאנחנו צריכים להיכנס לשם עכשיו.";
    // 43 chars -> breaks; 35 chars -> stays 1 line
    const shortHeb = "אני לא חושב שאנחנו צריכים להיכנס.";
    assert.equal(autoBreakHebrewLine(shortHeb, 42).includes("\n"), false);
  });

  it("breaks long Hebrew lines at natural punctuation or before conjunctions without breaking after את/של/על", () => {
    const heb = "אמרתי לך כבר אלף פעמים, אבל אתה פשוט מסרב להקשיב לכל מה שאני אומר.";
    const broken = autoBreakHebrewLine(heb, 42);
    const lines = broken.split("\n");
    assert.equal(lines.length, 2);
    // Should break right after the comma before "אבל"!
    assert.equal(lines[0], "אמרתי לך כבר אלף פעמים,");
    assert.equal(lines[1], "אבל אתה פשוט מסרב להקשיב לכל מה שאני אומר.");
  });

  it("never breaks right after Hebrew prepositions like את / של / על", () => {
    const heb = "אנחנו חייבים למצוא בהקדם האפשרי את המפתח הסודי של הדלת הזאת.";
    const broken = autoBreakHebrewLine(heb, 42);
    const lines = broken.split("\n");
    assert.equal(lines[0].endsWith(" את"), false);
    assert.equal(lines[0].endsWith(" של"), false);
  });

  it("wraps Hebrew lines with Unicode RLM (\\u200F) so Stremio renders punctuation & dashes on the right side", () => {
    const formatted = postProcessHebrewCue("- מה קורה פה?\n- אין לי מושג!", 42);
    const lines = formatted.split("\n");
    assert.equal(lines[0].startsWith("\u200F- "), true);
    assert.equal(lines[0].endsWith("?\u200F"), true);
    assert.equal(lines[1].startsWith("\u200F- "), true);
    assert.equal(lines[1].endsWith("!\u200F"), true);
  });
});

describe("Strict Exact-Sync Gate", () => {
  it("accepts exact videoHash matches and exact release group matches, rejecting mismatched releases", () => {
    const videoContext = {
      videoHash: "09a2c49766325920",
      filename: "Severance.S02E01.1080p.ATVP.WEB-DL.DDP5.1.H.264-FLUX.mkv",
    };

    const hashCand = {
      MatchedBy: "moviehash",
      MovieHash: "09a2c49766325920",
      SubFileName: "random.srt",
      SubHearingImpaired: "0",
    };
    assert.equal(scoreSubtitleSync(hashCand, videoContext) >= 1000, true);

    const groupCand = {
      MatchedBy: "imdbid",
      MovieReleaseName: "Severance.S02E01.1080p.ATVP.WEB-DL.DDP5.1.H.264-FLUX",
      SubHearingImpaired: "0",
    };
    assert.equal(scoreSubtitleSync(groupCand, videoContext) >= 300, true);

    const wrongBlurayCand = {
      MatchedBy: "imdbid",
      MovieReleaseName: "Severance.S02E01.720p.BluRay.x264-DEMAND",
      SubHearingImpaired: "0",
    };
    assert.equal(scoreSubtitleSync(wrongBlurayCand, videoContext), 0);
  });
});
